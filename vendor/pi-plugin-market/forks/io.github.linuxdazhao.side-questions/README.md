# Side Questions for PI-Desktop

Ask follow-ups beside a local Agent conversation. Choose a completed assistant reply and ask a question. The first send forks through that reply and opens the side conversation in the work panel.

## Use

1. Install Side Questions and approve its permissions.
2. In a local Agent conversation, open the work panel's `+` menu and choose **Side Questions**.
3. Select a completed reply and send your question. Use **History** to reopen an existing branch, **New** to start another, and **Stop** to stop the branch on screen.

The panel shows the new exchange. The forked prefix stays available to the Agent as context. PI-Desktop persists the conversations, and the plugin stores only the branch index in its private settings. The conversation list follows the host's ordinary fork behavior. Each branch uses the permissions of its forked host session. The host asks for confirmation before approving a tool or deleting a branch.

Requires PI-Desktop v0.23.0-beta.2 or newer and a configured model. The panel supports English and Simplified Chinese.

## Permissions

| Permission | Use |
| --- | --- |
| `ui.view` | Display the Side Questions work-panel view |
| `desktop.control` | Read the active source, fork at a reply, read and control the created branch, and resolve its user interactions |

The view keeps its bridge limited to the operations above. Its branch operations require a branch recorded for the active parent conversation. Replies and tool previews are rendered as text.

## Develop

Run `npm test` for the controller tests. From a PI-Desktop checkout, run the official `pi-plugin check` and `pi-plugin pack` commands with this checkout as the plugin directory.
