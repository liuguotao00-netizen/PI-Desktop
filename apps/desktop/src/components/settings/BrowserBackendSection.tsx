import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, Input, SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { useSettingsPersistence } from "../../features/settings/useSettingsPersistence";

type BackendState = {
  backendId: string;
  kind: string;
  tabId: string | null;
  capabilities: string[];
  transportStatus: string | null;
  extensionBridgeEndpoint?: string;
};

const KINDS = [
  { id: "cdp", label: "CDP" },
  { id: "extension", label: "Extension" },
  { id: "mcp", label: "MCP" },
  { id: "mcpapps", label: "MCP Apps" },
];

type BackendPrefs = { kind: string; endpoint: string; launch: boolean; profile: string; headless: boolean };

const DEFAULT_PREFS: BackendPrefs = {
  kind: "cdp",
  endpoint: "http://127.0.0.1:9222",
  launch: false,
  profile: "",
  headless: false,
};

/**
 * Backend choice is app-level and remembered even when no conversation is
 * open; only connecting binds it to a session.
 */
export function BrowserBackendSection() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);
  const newSession = useAppStore((state) => state.newSession);
  // Backend binding is per conversation. Settings may be open with no active
  // conversation (welcome screen), so fall back to the latest one; only when
  // there is no session at all do we ask the user to create one.
  const sessionId = activeSessionId ?? sessions[0]?.id ?? null;
  const { settings, saveSettings } = useSettingsPersistence();
  const stored = settings?.browser?.backend;
  const [state, setState] = useState<BackendState | null>(null);
  const [claimedTabId, setClaimedTabId] = useState<string | null>(null);
  const [kind, setKind] = useState(stored?.kind ?? DEFAULT_PREFS.kind);
  const [endpoint, setEndpoint] = useState(stored?.endpoint ?? DEFAULT_PREFS.endpoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [launch, setLaunch] = useState(stored?.launch === true);
  const [profile, setProfile] = useState(stored?.profile ?? "");
  const [headless, setHeadless] = useState(stored?.headless === true);
  const initialized = useRef(false);
  const persistTimer = useRef<number | undefined>(undefined);
  const [discovered, setDiscovered] = useState<Array<{ endpoint: string; browser: string; source: string; protocolVersion: string }>>([]);

  // Adopt stored values once; afterwards the local state is the editor.
  useEffect(() => {
    if (initialized.current || !stored) return;
    initialized.current = true;
    setKind(stored.kind ?? DEFAULT_PREFS.kind);
    setEndpoint(stored.endpoint ?? DEFAULT_PREFS.endpoint);
    setLaunch(stored.launch === true);
    setProfile(stored.profile ?? "");
    setHeadless(stored.headless === true);
  }, [stored]);

  // Persist edits to host settings (not renderer localStorage) after a short
  // idle, skipping the write when the stored value already matches.
  useEffect(() => {
    if (!settings) return;
    const saved = settings.browser?.backend ?? {};
    if (
      saved.kind === kind &&
      (saved.endpoint ?? DEFAULT_PREFS.endpoint) === endpoint &&
      (saved.launch === true) === launch &&
      (saved.profile ?? "") === profile &&
      (saved.headless === true) === headless
    ) return;
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void saveSettings({
        browser: {
          ...settings.browser,
          backend: { kind: kind as BackendPrefs["kind"] as never, endpoint, launch, profile, headless },
        },
      });
    }, 400);
    return () => window.clearTimeout(persistTimer.current);
  }, [kind, endpoint, launch, profile, headless, settings, saveSettings]);

  const refresh = useCallback(async () => {
    try {
      setState(await api.browserBackendState(sessionId ?? ""));
      if (sessionId) {
        const cua = await api.cuaState(sessionId);
        setClaimedTabId(cua.claimedTabId ?? null);
      } else {
        setClaimedTabId(null);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    const unsubscribe = api.onBrowserBackendStatus(({ sessionId: eventSession, status }) => {
      if (eventSession !== sessionId) return;
      setState((current) => (current ? { ...current, transportStatus: status } : current));
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [refresh, sessionId]);

  const discover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const found = await api.browserBackendDiscover();
      setDiscovered(found);
      if (found[0]) {
        setKind("cdp");
        setEndpoint(found[0].endpoint);
      } else {
        setError(t("settings.browserBackendNoEndpoint"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiscovering(false);
    }
  };

  const connect = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.browserBackendConnect({
        sessionId,
        kind,
        endpoint,
        ...(kind === "cdp" && launch
          ? {
              launch: true,
              ...(profile.trim() ? { userDataDir: profile.trim() } : {}),
              ...(headless ? { headless: true } : {}),
            }
          : {}),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.browserBackendDisconnect(sessionId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const external = state !== null && state.kind !== "embedded";
  const transportStatus = state?.transportStatus ?? null;
  const transportKey = transportStatus
    ? `settings.browserBackendTransport.${transportStatus}`
    : "settings.browserBackendTransport.idle";

  return (
    <SettingsCard title={t("settings.browserBackend")}>
      <SettingsRow title={t("settings.browserBackendCurrent")} description={t("settings.browserBackendDesc")}>
        <Badge>{external ? state.kind : t("settings.browserBackendEmbedded")}</Badge>
      </SettingsRow>
      {external ? (
        <SettingsRow title={t("settings.browserBackendTransportStatus")}>
          <Badge>{t(transportKey)}</Badge>
        </SettingsRow>
      ) : null}
      {external ? (
        <>
          <SettingsRow title={t("settings.browserBackendCapabilities")}>
            <span className="settings-row-detail">{state.capabilities.join(", ")}</span>
          </SettingsRow>
          <SettingsRow title={t("settings.browserBackendDisconnectDesc")}>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void disconnect()}>
              {t("settings.browserBackendDisconnect")}
            </Button>
          </SettingsRow>
        </>
      ) : (
        <>
          {!sessionId ? (
            <SettingsRow title={t("settings.browserBackendNoSession")} description={t("settings.browserBackendConnectDesc")}>
              <Button onClick={() => void newSession()}>{t("nav.newTask")}</Button>
            </SettingsRow>
          ) : null}
          <SettingsRow title={t("settings.browserBackendKind")}>
            <SettingsMenuSelect
              value={kind}
              options={KINDS}
              label={t("settings.browserBackendKind")}
              onChange={(next) => {
                setKind(next);
                setEndpoint(
                  next === "cdp"
                    ? "http://127.0.0.1:9222"
                    : next === "extension"
                      ? "ws://127.0.0.1:47123/pi-browser"
                      : "http://127.0.0.1:3000/mcp",
                );
              }}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.browserBackendDiscover")} description={t("settings.browserBackendDiscoverDesc")}>
            <Button variant="secondary" size="sm" disabled={discovering} onClick={() => void discover()}>
              {t(discovering ? "settings.browserBackendDiscovering" : "settings.browserBackendDiscover")}
            </Button>
          </SettingsRow>
          {discovered.length ? (
            <SettingsRow title={t("settings.browserBackendDiscovered")}>
              <span className="settings-row-detail">
                {discovered.length > 1 ? (
                  <SettingsMenuSelect
                    value={endpoint}
                    options={discovered.map((item) => ({
                      id: item.endpoint,
                      label: `${item.browser} · ${item.endpoint}`,
                    }))}
                    label={t("settings.browserBackendDiscovered")}
                    onChange={setEndpoint}
                  />
                ) : (
                  `${discovered[0].browser} · ${discovered[0].endpoint}`
                )}
              </span>
            </SettingsRow>
          ) : null}
          {kind === "extension" && state?.extensionBridgeEndpoint ? (
            <SettingsRow
              title={t("settings.browserExtensionBridge")}
              description={t("settings.browserExtensionBridgeDesc")}
            >
              <Input
                readOnly
                value={state.extensionBridgeEndpoint}
                aria-label={t("settings.browserExtensionBridge")}
                onFocus={(event) => event.currentTarget.select()}
              />
            </SettingsRow>
          ) : null}
          {kind === "cdp" ? (
            <SettingsRow title={t("settings.browserBackendLaunch")} description={t("settings.browserBackendLaunchDesc")}>
              <SettingsToggle checked={launch} label={t("settings.browserBackendLaunch")} onChange={() => setLaunch((value) => !value)} />
            </SettingsRow>
          ) : null}
          {kind === "cdp" && launch ? (
            <SettingsRow title={t("settings.browserBackendProfile")} description={t("settings.browserBackendProfileDesc")}>
              <Input
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
                placeholder="~/.pi-desktop/chrome-cdp-profile"
                aria-label={t("settings.browserBackendProfile")}
              />
            </SettingsRow>
          ) : null}
          {kind === "cdp" && launch ? (
            <SettingsRow title={t("settings.browserBackendHeadless")}>
              <SettingsToggle checked={headless} label={t("settings.browserBackendHeadless")} onChange={() => setHeadless((value) => !value)} />
            </SettingsRow>
          ) : null}
          {claimedTabId ? (
            <SettingsRow title={t("settings.browserBackendClaimedTab")} description={claimedTabId}>
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!sessionId) return;
                  await api.cuaClear(sessionId);
                  await refresh();
                }}
              >
                {t("settings.browserBackendReleaseTab")}
              </Button>
            </SettingsRow>
          ) : null}
          <SettingsRow title={t("settings.browserBackendEndpoint")} description={t("settings.browserBackendEndpointDesc")}>
            <Input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={
                kind === "cdp"
                  ? "http://127.0.0.1:9222"
                  : kind === "extension"
                    ? "ws://127.0.0.1:47123/pi-browser"
                    : "http://127.0.0.1:3000/mcp"
              }
              aria-label={t("settings.browserBackendEndpoint")}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.browserBackendConnectDesc")}>
            <Button variant="primary" size="sm" disabled={busy || !sessionId || !endpoint.trim()} onClick={() => void connect()}>
              {t(busy ? "settings.browserBackendConnecting" : "settings.browserBackendConnect")}
            </Button>
          </SettingsRow>
        </>
      )}
      {error ? <p className="browser-backend-error" role="alert">{error}</p> : null}
    </SettingsCard>
  );
}
