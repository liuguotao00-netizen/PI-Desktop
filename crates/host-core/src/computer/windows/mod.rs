//! Windows UI Automation backend for computer use.
//!
//! The backend is deliberately a thin adapter: it enumerates top-level windows,
//! exposes each window's control view as a bounded tree, and dispatches the
//! actions those controls advertise. All authorization still happens in
//! `computer::policy`; this module never chooses a target by itself.

#![allow(non_snake_case)]

use std::ffi::c_void;

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
    IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern, IUIAutomationTreeWalker,
    IUIAutomationValuePattern, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement,
    ScrollAmount_SmallIncrement, TreeScope_Children, UIA_InvokePatternId, UIA_ScrollPatternId,
    UIA_SelectionItemPatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetCursorPos,
};

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::{
    Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Rect, MAX_LABEL_CHARS,
};

const MAX_WINDOWS: usize = 256;

fn automation() -> Result<IUIAutomation, DesktopError> {
    // SAFETY: an explicit MTA initialization is idempotent; the S_FALSE and
    // RPC_E_CHANGED_MODE results both leave a usable COM apartment.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| DesktopError::Failed(error.to_string()))
    }
}

fn rect(value: RECT) -> Rect {
    Rect {
        x: f64::from(value.left),
        y: f64::from(value.top),
        width: f64::from(value.right - value.left),
        height: f64::from(value.bottom - value.top),
    }
}

fn role_name(control_type: i32) -> String {
    let name = match control_type {
        50000 => "UIAButton",
        50002 => "UIACalendar",
        50003 => "UIAComboBox",
        50004 => "UIAEdit",
        50005 => "UIAHyperlink",
        50006 => "UIAImage",
        50007 => "UIAList",
        50008 => "UIAListItem",
        50009 => "UIAMenu",
        50010 => "UIAMenuBar",
        50011 => "UIAMenuItem",
        50013 => "UIARadioButton",
        50014 => "UIAScrollBar",
        50015 => "UIASlider",
        50016 => "UIASpinner",
        50017 => "UIAStatusBar",
        50018 => "UIATab",
        50019 => "UIATabItem",
        50020 => "UIAText",
        50021 => "UIAToolBar",
        50022 => "UIAToolTip",
        50023 => "UIATree",
        50024 => "UIATreeItem",
        50025 => "UIACustom",
        50026 => "UIAGroup",
        50027 => "UIAThumb",
        50028 => "UIADataGrid",
        50029 => "UIADataItem",
        50030 => "UIADocument",
        50031 => "UIASplitButton",
        50032 => "UIAWindow",
        50033 => "UIAPane",
        50034 => "UIAHeader",
        50035 => "UIAHeaderItem",
        50036 => "UIATable",
        50037 => "UIATitleBar",
        50038 => "UIASeparator",
        50039 => "UIASemanticZoom",
        50040 => "UIAAppBar",
        _ => return format!("UIA{control_type}"),
    };
    name.to_string()
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

fn element_role(element: &IUIAutomationElement) -> String {
    // SAFETY: the element is alive for the call.
    unsafe {
        element
            .CurrentControlType()
            .map(|kind| role_name(kind.0))
            .unwrap_or_else(|_| "UIAUnknown".to_string())
    }
}

fn element_label(element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: the element is alive for the call.
    unsafe {
        element
            .CurrentName()
            .ok()
            .map(|name| name.to_string())
            .map(|name| name.chars().take(MAX_LABEL_CHARS).collect::<String>())
            .filter(|name| !name.trim().is_empty())
    }
}

fn element_bounds(element: &IUIAutomationElement) -> Option<Rect> {
    // SAFETY: the element is alive for the call.
    unsafe {
        element
            .CurrentBoundingRectangle()
            .ok()
            .map(rect)
            .filter(|value| value.width > 0.0 && value.height > 0.0)
    }
}

fn element_enabled(element: &IUIAutomationElement) -> bool {
    // SAFETY: the element is alive for the call.
    unsafe {
        element
            .CurrentIsEnabled()
            .map(|value| value.as_bool())
            .unwrap_or(false)
    }
}

fn element_focused(element: &IUIAutomationElement) -> bool {
    // SAFETY: the element is alive for the call.
    unsafe {
        element
            .CurrentHasKeyboardFocus()
            .map(|value| value.as_bool())
            .unwrap_or(false)
    }
}

fn has_pattern<T: Interface>(element: &IUIAutomationElement, id: i32) -> bool {
    // SAFETY: the element is alive for the call, and the pattern id is a UIA
    // constant from the generated bindings.
    unsafe {
        element
            .GetCurrentPatternAs::<T>(windows::Win32::UI::Accessibility::UIA_PATTERN_ID(id))
            .is_ok()
    }
}

fn element_actions(element: &IUIAutomationElement) -> Vec<ActionKind> {
    let mut actions = Vec::new();
    if has_pattern::<IUIAutomationInvokePattern>(element, UIA_InvokePatternId.0) {
        actions.push(ActionKind::Click);
    }
    if has_pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId.0) {
        actions.push(ActionKind::SetValue);
    }
    if has_pattern::<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId.0) {
        actions.push(ActionKind::Select);
    }
    if has_pattern::<IUIAutomationScrollPattern>(element, UIA_ScrollPatternId.0) {
        actions.push(ActionKind::Scroll);
    }
    if element_bounds(element).is_some() {
        actions.push(ActionKind::Drag);
    }
    actions
}

fn has_value(element: &IUIAutomationElement) -> bool {
    // SAFETY: the element is alive for the call.
    unsafe {
        if element
            .CurrentIsPassword()
            .map(|value| value.as_bool())
            .unwrap_or(false)
        {
            return false;
        }
        element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_ok()
    }
}

fn child_at(
    walker: &IUIAutomationTreeWalker,
    parent: &IUIAutomationElement,
    index: usize,
) -> Option<IUIAutomationElement> {
    // SAFETY: both objects are alive for the call.
    unsafe {
        let mut child = walker.GetFirstChildElement(parent).ok()?;
        for _ in 0..index {
            child = walker.GetNextSiblingElement(&child).ok()?;
        }
        Some(child)
    }
}

fn resolve(
    walker: &IUIAutomationTreeWalker,
    window: &IUIAutomationElement,
    uid: &str,
) -> Result<(IUIAutomationElement, u32), DesktopError> {
    let (path, digest) = parse_uid(uid).ok_or(DesktopError::ElementNotFound)?;
    let mut current = window.clone();
    for index in path {
        current = child_at(walker, &current, index).ok_or(DesktopError::ElementNotFound)?;
    }
    let role = element_role(&current);
    let label = element_label(&current);
    if identity_digest(&role, label.as_deref()) != digest {
        return Err(DesktopError::ElementNotFound);
    }
    Ok((current, digest))
}

fn process_key(pid: i32) -> String {
    // SAFETY: the process handle is closed before return, and the buffer is
    // owned by this call.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) else {
            return format!("pid:{pid}");
        };
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if result.is_err() || length == 0 {
            return format!("pid:{pid}");
        }
        String::from_utf16_lossy(&buffer[..length as usize])
    }
}

fn clickable_point(element: &IUIAutomationElement) -> Option<(i32, i32)> {
    // SAFETY: the output point is stack-owned, and the element is alive.
    unsafe {
        let mut point = POINT::default();
        element
            .GetClickablePoint(&mut point)
            .ok()
            .map(|_| (point.x, point.y))
    }
}

fn mouse_click(point: (i32, i32), right: bool, double: bool) -> Result<(), DesktopError> {
    // SAFETY: these are process-wide input calls with no borrowed pointers.
    unsafe {
        SetCursorPos(point.0, point.1).map_err(|error| DesktopError::Failed(error.to_string()))?;
        let (down, up) = if right {
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        } else {
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        };
        let clicks = if double { 2 } else { 1 };
        for _ in 0..clicks {
            mouse_event(down, 0, 0, 0, 0);
            mouse_event(up, 0, 0, 0, 0);
        }
    }
    Ok(())
}

fn mouse_drag(start: (i32, i32), end: (i32, i32)) -> Result<(), DesktopError> {
    // SAFETY: these are process-wide input calls with no borrowed pointers.
    unsafe {
        SetCursorPos(start.0, start.1).map_err(|error| DesktopError::Failed(error.to_string()))?;
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        for step in 1..=8 {
            let x = start.0 + (end.0 - start.0) * step / 8;
            let y = start.1 + (end.1 - start.1) * step / 8;
            SetCursorPos(x, y).map_err(|error| DesktopError::Failed(error.to_string()))?;
        }
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
    Ok(())
}

fn virtual_key(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    if lower.len() == 1 {
        let byte = lower.as_bytes()[0];
        if byte.is_ascii_alphabetic() {
            return Some(byte.to_ascii_uppercase());
        }
        if byte.is_ascii_digit() {
            return Some(byte);
        }
    }
    Some(match lower.as_str() {
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "escape" | "esc" => 0x1B,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        _ => return None,
    })
}

fn press_chord(chord: &str) -> Result<(), DesktopError> {
    let mut modifiers: Vec<u8> = Vec::new();
    let mut key = None;
    for part in chord.split('+') {
        let token = part.trim().to_ascii_lowercase();
        match token.as_str() {
            "ctrl" | "control" => modifiers.push(0x11),
            "shift" => modifiers.push(0x10),
            "alt" | "option" => modifiers.push(0x12),
            "cmd" | "command" | "meta" | "win" => modifiers.push(0x5B),
            "" => return Err(DesktopError::NotActionable),
            other => {
                if key.is_some() {
                    return Err(DesktopError::NotActionable);
                }
                key = Some(virtual_key(other).ok_or(DesktopError::NotActionable)?);
            }
        }
    }
    let key = key.ok_or(DesktopError::NotActionable)?;
    // SAFETY: process-wide keyboard input with no borrowed pointers.
    unsafe {
        for modifier in &modifiers {
            keybd_event(*modifier, 0, Default::default(), 0);
        }
        keybd_event(key, 0, Default::default(), 0);
        keybd_event(key, 0, KEYEVENTF_KEYUP, 0);
        for modifier in modifiers.iter().rev() {
            keybd_event(*modifier, 0, KEYEVENTF_KEYUP, 0);
        }
    }
    Ok(())
}

pub struct WindowsDesktop;

impl WindowsDesktop {
    pub fn new() -> Self {
        Self
    }

    fn automation(&self) -> Result<IUIAutomation, DesktopError> {
        automation()
    }

    fn walker(&self, automation: &IUIAutomation) -> Result<IUIAutomationTreeWalker, DesktopError> {
        // SAFETY: the automation object is alive for the call.
        unsafe {
            automation
                .ControlViewWalker()
                .map_err(|error| DesktopError::Failed(error.to_string()))
        }
    }

    fn window_element(
        &self,
        automation: &IUIAutomation,
        target: &TargetRef,
    ) -> Result<IUIAutomationElement, DesktopError> {
        // SAFETY: the handle comes from the target the policy admitted.
        unsafe {
            automation
                .ElementFromHandle(HWND(target.window as *mut c_void))
                .map_err(|_| DesktopError::TargetGone)
        }
    }

    fn walk(
        &self,
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
        path: &mut Vec<usize>,
        parent: Option<usize>,
        nodes: &mut Vec<Node>,
        max_nodes: usize,
    ) -> bool {
        if nodes.len() >= max_nodes {
            return true;
        }
        let role = element_role(element);
        let label = element_label(element);
        let bounds = element_bounds(element);
        let index = nodes.len();
        nodes.push(Node {
            uid: make_uid(path, &role, label.as_deref()),
            role,
            label,
            has_value: has_value(element),
            enabled: element_enabled(element),
            focused: element_focused(element),
            bounds,
            parent,
            actions: element_actions(element),
        });
        // SAFETY: both objects are alive for the call.
        let mut child = unsafe { walker.GetFirstChildElement(element).ok() };
        let mut child_index = 0usize;
        while let Some(current) = child {
            if nodes.len() >= max_nodes {
                return true;
            }
            path.push(child_index);
            let truncated = self.walk(walker, &current, path, Some(index), nodes, max_nodes);
            path.pop();
            if truncated {
                return true;
            }
            child_index += 1;
            // SAFETY: both objects are alive for the call.
            child = unsafe { walker.GetNextSiblingElement(&current).ok() };
        }
        false
    }
}

impl Desktop for WindowsDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: "win32".to_string(),
            backend: "windows-uia".to_string(),
            fidelity: Fidelity::Full,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        let automation = self.automation()?;
        let root = unsafe {
            automation
                .GetRootElement()
                .map_err(|error| DesktopError::Failed(error.to_string()))?
        };
        let condition = unsafe {
            automation
                .CreateTrueCondition()
                .map_err(|error| DesktopError::Failed(error.to_string()))?
        };
        let windows = unsafe {
            root.FindAll(TreeScope_Children, &condition)
                .map_err(|error| DesktopError::Failed(error.to_string()))?
        };
        let length = unsafe { windows.Length().unwrap_or(0) }.max(0) as usize;
        let mut targets = Vec::new();
        for index in 0..length.min(MAX_WINDOWS) {
            let Ok(element) = (unsafe { windows.GetElement(index as i32) }) else {
                continue;
            };
            let Ok(handle) = (unsafe { element.CurrentNativeWindowHandle() }) else {
                continue;
            };
            if handle.is_invalid() {
                continue;
            }
            let Ok(pid) = (unsafe { element.CurrentProcessId() }) else {
                continue;
            };
            let Some(bounds) = element_bounds(&element) else {
                continue;
            };
            let title = element_label(&element).unwrap_or_default();
            let app_key = process_key(pid);
            targets.push(RawTarget {
                target: TargetRef {
                    target_id: format!("win:{pid}:{}", handle.0 as usize),
                    pid,
                    window: handle.0 as usize as u64,
                    app_key: app_key.clone(),
                },
                app_name: app_key,
                title,
                bounds,
                elevated: false,
            });
        }
        Ok(targets)
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let automation = self.automation()?;
        let element = self.window_element(&automation, target)?;
        let bounds = element_bounds(&element).ok_or(DesktopError::TargetGone)?;
        let title = element_label(&element).unwrap_or_default();
        Ok(Measured {
            bounds,
            app_key: target.app_key.clone(),
            title,
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        let automation = self.automation()?;
        let element = self.window_element(&automation, target)?;
        let walker = self.walker(&automation)?;
        let mut nodes = Vec::new();
        let mut path = Vec::new();
        let truncated = self.walk(&walker, &element, &mut path, None, &mut nodes, max_nodes);
        Ok(RawInspection {
            nodes,
            truncated,
            fidelity: Fidelity::Full,
        })
    }

    fn secure_input_active(&self) -> bool {
        // SAFETY: both calls take no borrowed data and return owned handles.
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_invalid() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(foreground, Some(&mut pid));
            let exe = process_key(pid as i32).to_ascii_lowercase();
            exe.ends_with("logonui.exe") || exe.ends_with("lockapp.exe")
        }
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;
        if kind == ActionKind::LaunchApp {
            let app = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
            let status = std::process::Command::new("cmd")
                .args(["/C", "start", "", app])
                .status()
                .map_err(|error| DesktopError::Failed(error.to_string()))?;
            return if status.success() {
                Ok(Dispatched::WindowEvent)
            } else {
                Err(DesktopError::Failed("start failed".into()))
            };
        }
        let automation = self.automation()?;
        let window = self.window_element(&automation, target)?;
        let walker = self.walker(&automation)?;
        let uid = uid.ok_or(DesktopError::ElementNotFound)?;
        let (element, _) = resolve(&walker, &window, uid)?;
        match kind {
            ActionKind::Click => {
                let invoked = unsafe {
                    element
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .ok()
                        .and_then(|pattern| pattern.Invoke().ok())
                        .is_some()
                };
                if !invoked {
                    let point = clickable_point(&element)
                        .or_else(|| {
                            element_bounds(&element).map(|b| {
                                ((b.x + b.width / 2.0) as i32, (b.y + b.height / 2.0) as i32)
                            })
                        })
                        .ok_or(DesktopError::NotActionable)?;
                    mouse_click(point, false, false)?;
                }
            }
            ActionKind::SetValue => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                unsafe {
                    let pattern = element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .map_err(|_| DesktopError::NotActionable)?;
                    pattern
                        .SetValue(&BSTR::from(text))
                        .map_err(|_| DesktopError::NotActionable)?;
                }
            }
            ActionKind::Select => unsafe {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .map_err(|_| DesktopError::NotActionable)?;
                pattern.Select().map_err(|_| DesktopError::NotActionable)?;
            },
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                let amount = if scroll.dy >= 0.0 {
                    ScrollAmount_SmallIncrement
                } else {
                    ScrollAmount_SmallDecrement
                };
                unsafe {
                    let pattern = element
                        .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                        .map_err(|_| DesktopError::NotActionable)?;
                    pattern
                        .Scroll(ScrollAmount_NoAmount, amount)
                        .map_err(|_| DesktopError::NotActionable)?;
                }
            }
            ActionKind::DoubleClick | ActionKind::RightClick => {
                let point = clickable_point(&element)
                    .or_else(|| {
                        element_bounds(&element)
                            .map(|b| ((b.x + b.width / 2.0) as i32, (b.y + b.height / 2.0) as i32))
                    })
                    .ok_or(DesktopError::NotActionable)?;
                mouse_click(
                    point,
                    kind == ActionKind::RightClick,
                    kind == ActionKind::DoubleClick,
                )?;
            }
            ActionKind::Drag => {
                let start = action.point.ok_or(DesktopError::NotActionable)?;
                let end = action.to_point.ok_or(DesktopError::NotActionable)?;
                let bounds = element_bounds(&window).ok_or(DesktopError::TargetGone)?;
                mouse_drag(
                    ((bounds.x + start.x) as i32, (bounds.y + start.y) as i32),
                    ((bounds.x + end.x) as i32, (bounds.y + end.y) as i32),
                )?;
            }
            ActionKind::PressKeys => {
                let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
                unsafe {
                    element
                        .SetFocus()
                        .map_err(|_| DesktopError::NotActionable)?
                };
                for chord in keys {
                    press_chord(chord)?;
                }
            }
            ActionKind::PasteText => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                let mut clipboard = arboard::Clipboard::new()
                    .map_err(|error| DesktopError::Failed(error.to_string()))?;
                clipboard
                    .set_text(text)
                    .map_err(|error| DesktopError::Failed(error.to_string()))?;
                unsafe {
                    element
                        .SetFocus()
                        .map_err(|_| DesktopError::NotActionable)?
                };
                press_chord("ctrl+v")?;
            }
            ActionKind::SecondaryAction => {
                let option = action
                    .option
                    .as_deref()
                    .ok_or(DesktopError::NotActionable)?;
                match option {
                    "AXConfirm" => unsafe {
                        let pattern = element
                            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                            .map_err(|_| DesktopError::NotActionable)?;
                        pattern.Invoke().map_err(|_| DesktopError::NotActionable)?;
                    },
                    "AXCancel" => press_chord("escape")?,
                    "AXShowMenu" => {
                        let point = clickable_point(&element).ok_or(DesktopError::NotActionable)?;
                        mouse_click(point, true, false)?;
                    }
                    "AXIncrement" | "AXDecrement" => {
                        let pattern = unsafe {
                            element
                                .GetCurrentPatternAs::<IUIAutomationScrollPattern>(
                                    UIA_ScrollPatternId,
                                )
                                .map_err(|_| DesktopError::NotActionable)?
                        };
                        let amount = if option == "AXIncrement" {
                            ScrollAmount_SmallIncrement
                        } else {
                            ScrollAmount_SmallDecrement
                        };
                        unsafe {
                            pattern
                                .Scroll(ScrollAmount_NoAmount, amount)
                                .map_err(|_| DesktopError::NotActionable)?;
                        }
                    }
                    _ => return Err(DesktopError::NotActionable),
                }
            }
            ActionKind::LaunchApp => unreachable!("handled above"),
        }
        Ok(Dispatched::AccessibilityAction)
    }
}
