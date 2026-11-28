//! Linux AT-SPI backend for computer use.
//!
//! AT-SPI exposes the accessibility tree over D-Bus. This module maps the tree
//! onto the same bounded node contract as the macOS and Windows backends; it
//! never decides authorization. Pointer and keyboard synthesis is delegated to
//! `xdotool` where the accessibility interfaces cannot perform the action, and
//! Wayland sessions refuse input because no portable injection path exists.

#![allow(non_snake_case)]

use std::time::Duration;

use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
use atspi::proxy::action::ActionProxy;
use atspi::proxy::component::ComponentProxy;
use atspi::proxy::editable_text::EditableTextProxy;
use atspi::proxy::value::ValueProxy;
use atspi::{
    AccessibilityConnection, CoordType, Interface, InterfaceSet, ObjectRef, ScrollType, State,
    StateSet,
};

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::{
    Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Rect, MAX_LABEL_CHARS,
};

const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const MAX_WINDOWS: usize = 256;

fn runtime() -> Result<tokio::runtime::Runtime, DesktopError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| DesktopError::Failed(error.to_string()))
}

fn session_type() -> String {
    std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".to_string())
}

fn rect_from_extents(value: (i32, i32, i32, i32)) -> Rect {
    Rect {
        x: f64::from(value.0),
        y: f64::from(value.1),
        width: f64::from(value.2),
        height: f64::from(value.3),
    }
}

async fn root_proxy<'a>(
    connection: &'a AccessibilityConnection,
) -> Result<AccessibleProxy<'a>, DesktopError> {
    AccessibleProxy::builder(connection.connection())
        .destination("org.a11y.atspi.Registry")
        .map_err(|error| DesktopError::Failed(error.to_string()))?
        .path(ROOT_PATH)
        .map_err(|error| DesktopError::Failed(error.to_string()))?
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .build()
        .await
        .map_err(|error| DesktopError::Failed(error.to_string()))
}

async fn proxy_for<'a>(
    connection: &'a AccessibilityConnection,
    object: &'a ObjectRef,
) -> Result<AccessibleProxy<'a>, DesktopError> {
    object
        .as_accessible_proxy(connection.connection())
        .await
        .map_err(|error| DesktopError::Failed(error.to_string()))
}

async fn object_ref(proxy: &AccessibleProxy<'_>) -> Result<ObjectRef, DesktopError> {
    let name = proxy.inner().destination().to_string();
    let path = proxy.inner().path().to_string();
    Ok(ObjectRef {
        name: name
            .try_into()
            .map_err(|_| DesktopError::Failed("AT-SPI object name".into()))?,
        path: path
            .try_into()
            .map_err(|_| DesktopError::Failed("AT-SPI object path".into()))?,
    })
}

fn identity_digest(role: &str, label: Option<&str>) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in role.as_bytes().iter().chain(label.unwrap_or("").as_bytes()) {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn make_uid(path: &[usize], role: &str, label: Option<&str>) -> String {
    let joined = path
        .iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>()
        .join(".");
    format!("{joined}#{:x}", identity_digest(role, label))
}

fn parse_uid(uid: &str) -> Option<(Vec<usize>, u32)> {
    let (path, digest) = uid.split_once('#')?;
    let indices = path
        .split('.')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<usize>().ok())
        .collect::<Option<Vec<_>>>()?;
    let digest = u32::from_str_radix(digest, 16).ok()?;
    Some((indices, digest))
}

async fn label(proxy: &AccessibleProxy<'_>) -> Option<String> {
    proxy
        .name()
        .await
        .ok()
        .map(|name| name.chars().take(MAX_LABEL_CHARS).collect::<String>())
        .filter(|name| !name.trim().is_empty())
}

async fn bounds(connection: &AccessibilityConnection, object: &ObjectRef) -> Option<Rect> {
    let component = ComponentProxy::builder(connection.connection())
        .destination(object.name.as_str())
        .ok()?
        .path(object.path.as_str())
        .ok()?
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .build()
        .await
        .ok()?;
    component
        .get_extents(CoordType::Screen)
        .await
        .ok()
        .map(rect_from_extents)
        .filter(|value| value.width > 0.0 && value.height > 0.0)
}

async fn state(proxy: &AccessibleProxy<'_>) -> StateSet {
    proxy
        .get_state()
        .await
        .unwrap_or_else(|_| StateSet::new(State::Defunct))
}

async fn actions(
    connection: &AccessibilityConnection,
    proxy: &AccessibleProxy<'_>,
    object: &ObjectRef,
) -> Vec<ActionKind> {
    let mut kinds = Vec::new();
    let interfaces = proxy
        .get_interfaces()
        .await
        .unwrap_or_else(|_| InterfaceSet::empty());
    if interfaces.contains(Interface::Action) {
        if let Ok(builder) = ActionProxy::builder(connection.connection())
            .destination(object.name.as_str())
            .and_then(|builder| builder.path(object.path.as_str()))
        {
            let action = builder
                .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                .build()
                .await;
            if let Ok(action) = action {
                if action
                    .get_actions()
                    .await
                    .map(|list| !list.is_empty())
                    .unwrap_or(false)
                {
                    kinds.push(ActionKind::Click);
                }
            }
        }
    }
    if interfaces.contains(Interface::EditableText) || interfaces.contains(Interface::Value) {
        kinds.push(ActionKind::SetValue);
    }
    if interfaces.contains(Interface::Component) {
        kinds.push(ActionKind::Drag);
        if interfaces.contains(Interface::Action) {
            kinds.push(ActionKind::Scroll);
        }
    }
    kinds.sort_by_key(|kind| kind.as_str());
    kinds.dedup();
    kinds
}

pub struct LinuxDesktop;

impl LinuxDesktop {
    pub fn new() -> Self {
        Self
    }

    fn is_wayland(&self) -> bool {
        session_type().eq_ignore_ascii_case("wayland")
    }

    fn run<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, DesktopError>>,
    ) -> Result<T, DesktopError> {
        let runtime = runtime()?;
        runtime.block_on(future)
    }

    async fn connection() -> Result<AccessibilityConnection, DesktopError> {
        tokio::time::timeout(Duration::from_secs(5), AccessibilityConnection::new())
            .await
            .map_err(|_| DesktopError::Timeout)?
            .map_err(|error| DesktopError::Failed(error.to_string()))
    }

    async fn window_proxy<'a>(
        connection: &'a AccessibilityConnection,
        target: &TargetRef,
    ) -> Result<AccessibleProxy<'a>, DesktopError> {
        let raw = target
            .target_id
            .strip_prefix("atspi:")
            .unwrap_or(&target.target_id);
        let (destination, raw_path) = raw.split_once('|').ok_or(DesktopError::TargetGone)?;
        let destination: atspi::zbus::names::OwnedBusName = destination
            .try_into()
            .map_err(|_| DesktopError::TargetGone)?;
        let destination = destination.into_inner();
        let path: atspi::zbus::zvariant::OwnedObjectPath =
            raw_path.try_into().map_err(|_| DesktopError::TargetGone)?;
        let path = path.into_inner();
        let builder = AccessibleProxy::builder(connection.connection())
            .destination(destination)
            .map_err(|_| DesktopError::TargetGone)?;
        let builder = builder.path(path).map_err(|_| DesktopError::TargetGone)?;
        builder
            .cache_properties(atspi::zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|_| DesktopError::TargetGone)
    }
}

impl Desktop for LinuxDesktop {
    fn capabilities(&self) -> Capabilities {
        let wayland = self.is_wayland();
        Capabilities {
            platform: "linux".to_string(),
            backend: "linux-atspi".to_string(),
            fidelity: Fidelity::Full,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: Some(session_type()),
            input_unsupported_reason: wayland.then(|| {
                "Wayland has no portable synthetic input path; use an X11 session or a desktop portal plugin"
                    .to_string()
            }),
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.run(async {
            let connection = Self::connection().await?;
            let root = root_proxy(&connection).await?;
            let apps = root
                .get_children()
                .await
                .map_err(|error| DesktopError::Failed(error.to_string()))?;
            let mut targets = Vec::new();
            for app in apps.iter().take(MAX_WINDOWS) {
                let app_proxy = proxy_for(&connection, app).await?;
                let app_name = label(&app_proxy)
                    .await
                    .unwrap_or_else(|| "Application".into());
                let windows = app_proxy
                    .get_children()
                    .await
                    .map_err(|error| DesktopError::Failed(error.to_string()))?;
                for window in windows.iter().take(MAX_WINDOWS) {
                    let proxy = proxy_for(&connection, window).await?;
                    let Some(bounds) = bounds(&connection, window).await else {
                        continue;
                    };
                    let title = label(&proxy).await.unwrap_or_default();
                    targets.push(RawTarget {
                        target: TargetRef {
                            target_id: format!(
                                "atspi:{}|{}",
                                window.name.as_str(),
                                window.path.as_str()
                            ),
                            pid: 0,
                            window: 0,
                            app_key: app_name.clone(),
                        },
                        app_name: app_name.clone(),
                        title,
                        bounds,
                        elevated: false,
                    });
                }
            }
            Ok(targets)
        })
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        self.run(async {
            let connection = Self::connection().await?;
            let proxy = Self::window_proxy(&connection, target).await?;
            let object = object_ref(&proxy).await?;
            let bounds = bounds(&connection, &object)
                .await
                .ok_or(DesktopError::TargetGone)?;
            let title = label(&proxy).await.unwrap_or_default();
            Ok(Measured {
                bounds,
                app_key: target.app_key.clone(),
                title,
            })
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        self.run(async {
            let connection = Self::connection().await?;
            let window = Self::window_proxy(&connection, target).await?;
            let window_object = object_ref(&window).await?;
            let mut nodes = Vec::new();
            let mut stack = vec![(window_object, Vec::<usize>::new(), None)];
            let mut truncated = false;
            while let Some((object, path, parent)) = stack.pop() {
                if nodes.len() >= max_nodes {
                    truncated = true;
                    break;
                }
                let proxy = proxy_for(&connection, &object).await?;
                let role = proxy
                    .get_role_name()
                    .await
                    .unwrap_or_else(|_| "ATSPIUnknown".into());
                let label = label(&proxy).await;
                let node_bounds = bounds(&connection, &object).await;
                let states = state(&proxy).await;
                let node_actions = actions(&connection, &proxy, &object).await;
                let index = nodes.len();
                nodes.push(Node {
                    uid: make_uid(&path, &role, label.as_deref()),
                    role,
                    label,
                    has_value: node_actions.contains(&ActionKind::SetValue),
                    enabled: states.contains(State::Enabled) && !states.contains(State::Defunct),
                    focused: states.contains(State::Focused),
                    bounds: node_bounds,
                    parent,
                    actions: node_actions,
                });
                let children = proxy
                    .get_children()
                    .await
                    .map_err(|error| DesktopError::Failed(error.to_string()))?;
                for (child_index, child) in children.into_iter().enumerate().rev() {
                    let mut child_path = path.clone();
                    child_path.push(child_index);
                    stack.push((child, child_path, Some(index)));
                }
                let _ = index;
            }
            Ok(RawInspection {
                nodes,
                truncated,
                fidelity: Fidelity::Full,
            })
        })
    }

    fn secure_input_active(&self) -> bool {
        false
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        if self.is_wayland() {
            return Err(DesktopError::Unsupported);
        }
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;
        if kind == ActionKind::LaunchApp {
            let app = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
            let status = std::process::Command::new("gtk-launch")
                .arg(app)
                .status()
                .map_err(|error| DesktopError::Failed(error.to_string()))?;
            return if status.success() {
                Ok(Dispatched::WindowEvent)
            } else {
                Err(DesktopError::Failed("gtk-launch failed".into()))
            };
        }
        let uid = uid.ok_or(DesktopError::ElementNotFound)?;
        let (path, digest) = parse_uid(uid).ok_or(DesktopError::ElementNotFound)?;
        self.run(async {
            let connection = Self::connection().await?;
            let window = Self::window_proxy(&connection, target).await?;
            let mut object = object_ref(&window).await?;
            for index in path {
                let proxy = proxy_for(&connection, &object).await?;
                let children = proxy
                    .get_children()
                    .await
                    .map_err(|error| DesktopError::Failed(error.to_string()))?;
                object = children
                    .get(index)
                    .cloned()
                    .ok_or(DesktopError::ElementNotFound)?;
            }
            let proxy = proxy_for(&connection, &object).await?;
            let role = proxy
                .get_role_name()
                .await
                .unwrap_or_else(|_| "ATSPIUnknown".into());
            if identity_digest(&role, label(&proxy).await.as_deref()) != digest {
                return Err(DesktopError::ElementNotFound);
            }
            let point = action.point;
            match kind {
                ActionKind::Click | ActionKind::DoubleClick => {
                    let action_proxy = ActionProxy::builder(connection.connection())
                        .destination(object.name.as_str())
                        .and_then(|builder| builder.path(object.path.as_str()))
                        .map_err(|_| DesktopError::NotActionable)?
                        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                        .build()
                        .await
                        .map_err(|_| DesktopError::NotActionable)?;
                    action_proxy
                        .do_action(0)
                        .await
                        .map_err(|_| DesktopError::NotActionable)?;
                    if kind == ActionKind::DoubleClick {
                        action_proxy
                            .do_action(0)
                            .await
                            .map_err(|_| DesktopError::NotActionable)?;
                    }
                }
                ActionKind::SetValue => {
                    let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                    let editable = EditableTextProxy::builder(connection.connection())
                        .destination(object.name.as_str())
                        .and_then(|builder| builder.path(object.path.as_str()))
                        .map_err(|_| DesktopError::NotActionable)?
                        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                        .build()
                        .await;
                    if let Ok(editable) = editable {
                        editable
                            .set_text_contents(text)
                            .await
                            .map_err(|_| DesktopError::NotActionable)?;
                    } else if let Ok(value) = ValueProxy::builder(connection.connection())
                        .destination(object.name.as_str())
                        .and_then(|builder| builder.path(object.path.as_str()))
                        .map_err(|_| DesktopError::NotActionable)?
                        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                        .build()
                        .await
                    {
                        let number = text
                            .parse::<f64>()
                            .map_err(|_| DesktopError::NotActionable)?;
                        value
                            .set_current_value(number)
                            .await
                            .map_err(|_| DesktopError::NotActionable)?;
                    } else {
                        return Err(DesktopError::NotActionable);
                    }
                }
                ActionKind::Scroll => {
                    let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                    let component = ComponentProxy::builder(connection.connection())
                        .destination(object.name.as_str())
                        .and_then(|builder| builder.path(object.path.as_str()))
                        .map_err(|_| DesktopError::NotActionable)?
                        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                        .build()
                        .await
                        .map_err(|_| DesktopError::NotActionable)?;
                    let direction = if scroll.dy >= 0.0 {
                        ScrollType::BottomRight
                    } else {
                        ScrollType::TopLeft
                    };
                    component
                        .scroll_to(direction)
                        .await
                        .map_err(|_| DesktopError::NotActionable)?;
                }
                ActionKind::RightClick => {
                    let point = point.ok_or(DesktopError::NotActionable)?;
                    let bounds = bounds(&connection, &object)
                        .await
                        .ok_or(DesktopError::TargetGone)?;
                    xdotool(&[
                        "mousemove",
                        &((bounds.x + point.x) as i64).to_string(),
                        &((bounds.y + point.y) as i64).to_string(),
                        "click",
                        "3",
                    ])?;
                }
                ActionKind::Drag => {
                    let start = action.point.ok_or(DesktopError::NotActionable)?;
                    let end = action.to_point.ok_or(DesktopError::NotActionable)?;
                    let bounds = bounds(&connection, &object)
                        .await
                        .ok_or(DesktopError::TargetGone)?;
                    xdotool(&[
                        "mousemove",
                        &((bounds.x + start.x) as i64).to_string(),
                        &((bounds.y + start.y) as i64).to_string(),
                        "mousedown",
                        "1",
                        "mousemove",
                        &((bounds.x + end.x) as i64).to_string(),
                        &((bounds.y + end.y) as i64).to_string(),
                        "mouseup",
                        "1",
                    ])?;
                }
                ActionKind::PressKeys => {
                    let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
                    let component = ComponentProxy::builder(connection.connection())
                        .destination(object.name.as_str())
                        .and_then(|builder| builder.path(object.path.as_str()))
                        .map_err(|_| DesktopError::NotActionable)?
                        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                        .build()
                        .await
                        .map_err(|_| DesktopError::NotActionable)?;
                    component
                        .grab_focus()
                        .await
                        .map_err(|_| DesktopError::NotActionable)?;
                    for chord in keys {
                        xdotool(&["key", chord])?;
                    }
                }
                ActionKind::PasteText => {
                    let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                    let mut clipboard = arboard::Clipboard::new()
                        .map_err(|error| DesktopError::Failed(error.to_string()))?;
                    clipboard
                        .set_text(text)
                        .map_err(|error| DesktopError::Failed(error.to_string()))?;
                    xdotool(&["key", "ctrl+v"])?;
                }
                ActionKind::SecondaryAction => {
                    let option = action
                        .option
                        .as_deref()
                        .ok_or(DesktopError::NotActionable)?;
                    match option {
                        "AXCancel" => xdotool(&["key", "Escape"])?,
                        "AXConfirm" => {
                            let action_proxy = ActionProxy::builder(connection.connection())
                                .destination(object.name.as_str())
                                .and_then(|builder| builder.path(object.path.as_str()))
                                .map_err(|_| DesktopError::NotActionable)?
                                .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                                .build()
                                .await
                                .map_err(|_| DesktopError::NotActionable)?;
                            action_proxy
                                .do_action(0)
                                .await
                                .map_err(|_| DesktopError::NotActionable)?;
                        }
                        _ => return Err(DesktopError::NotActionable),
                    }
                }
                ActionKind::Select | ActionKind::LaunchApp => {
                    return Err(DesktopError::NotActionable)
                }
            }
            Ok(Dispatched::WindowEvent)
        })
    }
}

fn xdotool(arguments: &[&str]) -> Result<(), DesktopError> {
    let status = std::process::Command::new("xdotool")
        .args(arguments)
        .status()
        .map_err(|error| DesktopError::Failed(error.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(DesktopError::NotActionable)
    }
}
