# CacheTray — Interview Prep Hub

This folder is your **study + practice kit** for talking about this project in interviews.
Everything here is written in plain English first, with the *real code from your repo*
second. Read it out loud. If you can explain a section to a friend, you're ready.

---

## The one-line pitch (memorize this word for word)

> "CacheTray is a Chrome extension — a clipboard manager built for AI workflows. It
> captures screenshots, links, code and text while you browse, then sends them straight
> into ChatGPT or Claude in one click. I also built the marketing site, where all the
> product demos are **live DOM animations**, not videos."

Say that, pause, and let them ask a follow-up. That sentence contains three hooks
(extension, AI workflow, live animations) — an interviewer will grab one.

---

## What's in this folder (do them in order)

| # | Module | What you do | Status |
|---|--------|-------------|--------|
| 1 | `01-animations-deep-dive.md` | **Read & learn.** Every animation concept, simple + real code. | ✅ ready |
| 2 | `02-mock-interview.md` | **Practice.** Real interview questions + model answers + follow-ups. | ⏳ next |
| 3 | `03-refactor-walkthrough.md` | **Learn clean code.** We rewrite one demo together, line by line. | ⏳ later |
| 4 | `04-build-from-scratch.md` | **Build.** Add a brand-new animation, step by step. | ⏳ later |

---

## How to study (a realistic 5-day plan)

- **Day 1** — Read Module 1 slowly. Don't memorize code; understand the *ideas*
  (fake cursor, CSS transitions, `async/await`, `IntersectionObserver`).
- **Day 2** — Re-read Module 1. Cover the code and try to explain each concept from
  the "Say this in an interview" boxes only.
- **Day 3** — Do Module 2 (mock interview). Answer out loud *before* reading my answer.
- **Day 4** — Module 3 (refactor). This is where clean-code instinct is built.
- **Day 5** — Module 4 (build from scratch) + re-do the mock interview cold.

---

## The 6 concepts you must be able to explain (your core vocabulary)

1. **Live DOM vs. video** — the demos are real HTML driven by a script, not recordings.
2. **CSS transitions** — you change one value, the browser animates the frames on the GPU.
3. **`getBoundingClientRect()`** — how you find an element's real pixel position on screen.
4. **`async/await` + Promises** — how you sequence animation steps like a screenplay.
5. **`IntersectionObserver`** — the efficient way to animate things as they scroll into view.
6. **Re-entrancy guard (a lock)** — a boolean flag so an animation can't run twice at once.

If you know only these six cold, you can hold a 15-minute conversation about this project.
