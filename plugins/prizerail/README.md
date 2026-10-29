# Prizerail plugin for Claude Code

Three skills for building on [Prizerail](https://www.prizerail.com):

- **prizerail-integrate**: add Prizerail to an app so its users enter the partner's prize draws.
- **prizerail-check**: check an integration end to end with `npx prizerail check`.
- **prizerail-draw**: look up a campaign's draws and verify one from its public proof.

Install it in Claude Code:

```
/plugin marketplace add coordinationlabs/prizerail-js-sdk
/plugin install prizerail@prizerail
```

The same skills are served as plain files for any agent that reads them: [prizerail-integrate](https://www.prizerail.com/skills/prizerail-integrate/SKILL.md), [prizerail-check](https://www.prizerail.com/skills/prizerail-check/SKILL.md) and [prizerail-draw](https://www.prizerail.com/verify/SKILL.md). The copies here ship in the `prizerail` package too, and prizerail.com's tests fail if its served files differ from them.
