---
name: configure
description: Interactively save persistent model preferences for InternAgent.
disable-model-invocation: true
---

Use the interactive AskUserQuestion tool in the main conversation. Work from the project root. Run each command separately as `node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" <arguments>` with the literal expanded path.

1. Run `models` to read the current defaults. Briefly show the effective planner, builder, and reviewer models. If reading fails, report the problem and leave the files alone.
2. Ask two single-select questions. For scope, offer **User** (all projects) and **Project** (this project). For role, offer **Default** (all roles without a role override), **Planner**, **Builder**, and **Reviewer**.
3. Ask for the model. Offer **Opus**, **Sonnet**, **Haiku**, and **More options**. For More options, offer **Inherit session model**, **Fable**, and **Clear this setting**. Map the last group to `inherit`, `fable`, and `clear`.
4. After the user chooses all three values, run `configure <scope> <role> <alias>` with the selected lowercase tokens. Treat a cancellation as a request to leave the configuration unchanged. If AskUserQuestion is unavailable, ask the same questions in chat and wait for the answers before writing.
5. Run `models` again and show where the choice was saved and which aliases will apply to new runs. Existing runs keep their recorded settings. If the effective alias differs from the saved choice, explain that a more specific setting takes precedence.
