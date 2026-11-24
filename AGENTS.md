# GAIA contributor contract

This repository builds a simulation-first, eventually playable universe.

1. Read `docs/PROJECT_BRIEF.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP.md` before starting work.
2. Work in a feature branch named `feat/<scope>`, `fix/<scope>`, or `docs/<scope>`. Do not push directly to `main`.
3. Keep simulation code in `src/sim` deterministic and independent of browser APIs and rendering.
4. Use a seeded PRNG; never call `Math.random()` or read wall-clock time inside simulation logic.
5. Prefer small observable, testable world rules. Do not prematurely add frameworks or LLM calls per agent.
6. Preserve simulation state compatibility deliberately; document breaking changes.
7. Include at least one relevant test for every rule introduced or changed.
8. Before merging, run `npm test`, `npm run typecheck`, and `npm run build`.
9. Summarize changes, rationale, tests, and any tradeoffs in the pull request.
10. No claims of real physics or learned intelligence unless the implementation demonstrably provides it.
