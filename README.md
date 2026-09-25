# Waterboy

An assistant you text over iMessage, running on your Mac, with Claude or ChatGPT writing the replies.

| Folder | What it is |
|---|---|
| [`waterboy-agent/`](waterboy-agent/README.md) | The service: watches Messages, runs each conversation through the Claude Agent SDK, replies, and runs automations and the fantasy football tools. Installed as the launchd job `local.waterboy`. |
| [`waterboy-desktop/`](waterboy-desktop/README.md) | The macOS control panel (Electron): status, who can talk to it, memory, automations, logs and settings. Also builds the signed installer, which bundles the service. |

Runtime data (state, logs, memory, chat folders) lives in `~/.imessage-agent`.

Installed from the DMG, Waterboy.app sets up the service itself on first launch. From source:

```bash
cd waterboy-agent && npm install && npm run install-service   # service
cd waterboy-desktop && npm install && npm start                # control panel
```

## License

Waterboy is released under the [MIT License](LICENSE).

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and the Claude Code binary it includes are not
covered by that license. They're © Anthropic PBC, all rights reserved, and subject to
[Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). The desktop
installer bundles them as part of the service. The Codex SDK and CLI used for the ChatGPT assistant
(`@openai/codex-sdk`, `@openai/codex`) are Apache-2.0, © OpenAI, and using them with a ChatGPT
sign-in is subject to OpenAI's terms. Other dependencies (Electron, croner, zod and more) keep
their own open-source licenses, mostly MIT.
