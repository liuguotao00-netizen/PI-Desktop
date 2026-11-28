import { useTranslation } from "react-i18next";
import { Input, SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { useSettingsPersistence } from "../../features/settings/useSettingsPersistence";
import type { BrowserSettings } from "@pi-desktop/shared";

/**
 * Browser chrome and behavior, shaped after the Codex browser settings page:
 * it owns what the user sees (bookmarks bar, toolbars, full URL) and how links
 * and downloads behave, while the backend card owns the connection.
 */
export function BrowserChromeSettingsSection() {
  const { t } = useTranslation();
  const { settings, saveSettings } = useSettingsPersistence();
  if (!settings) return null;
  const browser: BrowserSettings = settings.browser ?? {};
  const save = (patch: Partial<BrowserSettings>) =>
    void saveSettings({ browser: { ...browser, ...patch } });

  const shortcuts = [
    { id: "primary", label: t("settings.browserShortcutPrimary") },
    { id: "alt", label: t("settings.browserShortcutAlt") },
    { id: "primary-shift", label: t("settings.browserShortcutPrimaryShift") },
    { id: "unassigned", label: t("settings.browserShortcutUnassigned") },
  ];

  return (
    <>
      <SettingsCard title={t("settings.browserChrome")}>
        <SettingsRow
          title={t("settings.browserShowFullUrl")}
          description={t("settings.browserShowFullUrlDesc")}
        >
          <SettingsToggle
            checked={browser.showFullUrl === true}
            label={t("settings.browserShowFullUrl")}
            onChange={() => save({ showFullUrl: browser.showFullUrl !== true })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.browserBookmarksBar")}
          description={t("settings.browserBookmarksBarDesc")}
        >
          <SettingsMenuSelect
            value={browser.bookmarksBarVisibility ?? "new-tab"}
            onChange={(value) =>
              save({ bookmarksBarVisibility: value as BrowserSettings["bookmarksBarVisibility"] })
            }
            options={[
              { id: "always", label: t("settings.browserBookmarksAlways") },
              { id: "new-tab", label: t("settings.browserBookmarksNewTab") },
              { id: "never", label: t("settings.browserBookmarksNever") },
            ]}
            label={t("settings.browserBookmarksBar")}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.browserExtensionsToolbar")}
          description={t("settings.browserExtensionsToolbarDesc")}
        >
          <SettingsToggle
            checked={browser.extensionsToolbarVisible !== false}
            label={t("settings.browserExtensionsToolbar")}
            onChange={() => save({ extensionsToolbarVisible: browser.extensionsToolbarVisible === false })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.browserDeviceToolbar")}
          description={t("settings.browserDeviceToolbarDesc")}
        >
          <SettingsToggle
            checked={browser.deviceToolbarVisible === true}
            label={t("settings.browserDeviceToolbar")}
            onChange={() => save({ deviceToolbarVisible: browser.deviceToolbarVisible !== true })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.browserDownloads")}>
        <SettingsRow
          title={t("settings.browserDownloadDirectory")}
          description={t("settings.browserDownloadDirectoryDesc")}
        >
          <Input
            value={browser.downloadDirectory ?? ""}
            placeholder="~/Downloads"
            onChange={(event) => save({ downloadDirectory: event.target.value.trim() || null })}
            aria-label={t("settings.browserDownloadDirectory")}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.browserDownloadPrompt")}
          description={t("settings.browserDownloadPromptDesc")}
        >
          <SettingsToggle
            checked={browser.downloadPrompt === true}
            label={t("settings.browserDownloadPrompt")}
            onChange={() => save({ downloadPrompt: browser.downloadPrompt !== true })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.browserLinkTarget")}>
        <SettingsRow
          title={t("settings.browserLinkTarget")}
          description={t("settings.browserLinkTargetDesc")}
        >
          <SettingsMenuSelect
            value={browser.linkTarget ?? "in-app-browser"}
            onChange={(value) =>
              save({ linkTarget: value === "external-browser" ? "external-browser" : "in-app-browser" })
            }
            options={[
              { id: "in-app-browser", label: t("settings.browserLinkTargetInApp") },
              { id: "external-browser", label: t("settings.browserLinkTargetExternal") },
            ]}
            label={t("settings.browserLinkTarget")}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.browserExternalShortcut")}
          description={t("settings.browserExternalShortcutDesc")}
        >
          <SettingsMenuSelect
            value={browser.externalLinkShortcut ?? "primary"}
            onChange={(value) =>
              save({
                externalLinkShortcut: (shortcuts.some((item) => item.id === value)
                  ? value
                  : "primary") as BrowserSettings["externalLinkShortcut"],
              })
            }
            options={shortcuts.map((item) => ({ id: item.id, label: item.label }))}
            label={t("settings.browserExternalShortcut")}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.browserBackgroundNetworking")}>
        <SettingsRow
          title={t("settings.browserBackgroundNetworking")}
          description={t("settings.browserBackgroundNetworkingDesc")}
        >
          <SettingsToggle
            checked={browser.backgroundNetworkingDisabled === true}
            label={t("settings.browserBackgroundNetworking")}
            onChange={() =>
              save({ backgroundNetworkingDisabled: browser.backgroundNetworkingDisabled !== true })
            }
          />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
