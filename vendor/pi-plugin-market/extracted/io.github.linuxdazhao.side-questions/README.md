# Side Questions for PI-Desktop

Ask follow-ups beside a local Agent conversation. Start from a completed assistant reply or paste an excerpt into a fresh conversation.

## Use

1. Install Side Questions and approve its permissions.
2. In a local Agent conversation, open the work panel's `+` menu and choose **Side Questions**.
3. Select a completed reply, or paste plain text into **Paste text as a reference…**. The pasted text appears as a short chip. Click **×** to remove the entire reference before sending.
4. Enter your question and send it. Use **History** to reopen a branch, **New** to start another, and **Stop** to stop the branch on screen.

On PI-Desktop builds with [transcript selection actions](https://github.com/vastsa/PI-Desktop/pull/2446), select text in a chat message, right-click, and choose **Side Questions** (the branch icon). This opens a fresh side draft with a removable excerpt. Enter a question and send it to start a new conversation with that excerpt. PI-Desktop v0.23.0 and earlier supported builds use the work-panel paste option.

Selecting a reply forks the main conversation through that reply, inheriting the fork's permissions. Pasting creates an empty conversation on first send with the excerpt and question as the first user message. Removing the reference leaves the draft in **New conversation** mode. Fresh conversations use the host's normal permission defaults. PI-Desktop persists both kinds of conversations, and the plugin keeps only their history index in its settings. The host asks for confirmation before approving a tool or deleting a branch.

Requires PI-Desktop v0.23.0-beta.2 or newer and a configured model. The panel supports English and Simplified Chinese.

## Permissions

| Permission | Use |
| --- | --- |
| `ui.view` | Display the Side Questions work-panel view |
| `desktop.control` | Read the active source, create or fork a conversation, control the created branch, and resolve its user interactions |

The view keeps its bridge limited to the operations above. Its branch operations require a branch recorded for the active parent conversation. Replies and tool previews are rendered as text.

## Develop

Run `npm test` for the controller tests. From a PI-Desktop checkout, run the official `pi-plugin check` and `pi-plugin pack` commands with this checkout as the plugin directory.
