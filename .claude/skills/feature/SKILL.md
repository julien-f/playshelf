---
name: feature
description: Take a new feature request (not yet a backlog item) from idea to merge — proposals weighed by specialist agents and as the app's users, the user's choice, a plan, a branch, test-first steps, and a merge after the user's own test. Use when the user asks for a new feature or capability, asks how the app could support something, or asks for proposals or a brainstorm about one. A U- or C-item goes to fix; choosing among backlog items to backlog-run.
---

# Feature

A request for something the app doesn't do yet. Fixing a filed item is [fix](../fix/SKILL.md); once a proposal is chosen, this ships like a [backlog run](../backlog-run/SKILL.md).

## Frame

- Note the start time (ISO) for the log.
- Who it's for and what they're trying to do: the matching _Who / goal_ in [journeys.md](../../../docs/dev/journeys.md), and what the app already does nearby ([features.md](../../../docs/user/features.md)).
- Check [improvements.md](../../../docs/dev/improvements.md), [code-backlog.md](../../../docs/dev/code-backlog.md) and [decisions.md](../../../docs/dev/decisions.md): it may be filed, or declined with a reason.
- A new upstream: [integrations.md](../../../docs/dev/integrations.md#trust-tiers)'s trust tiers first.

## Proposals

- Two to four approaches, each with what the user gets, its cost and its risk. One `Agent` per area it touches plus one as the app's users, all in one message; drop or merge what they sink.
- Explain the result in plain words, then ask in one `AskUserQuestion`, recommendation first. A visual choice goes on a mockup page first ([fix's Before starting](../fix/SKILL.md#before-starting)).

## Ship

[backlog-run](../backlog-run/SKILL.md) from Plan through Log, with the same reviewers as Proposals, and:

- Each step test-first through [fix](../fix/SKILL.md)'s Test first, Fix and Look; no item to re-verify or close. `docs/user/` updated with the step that changes what users see.
- Logged as `feature:<slug>`, the proposal agents' tokens under `triage`.

## Report

What shipped and where to see it (route and steps), what was left out and why.
