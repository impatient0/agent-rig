# Human-in-the-Loop UI Change Gate

Any change that alters user-facing layout, visual hierarchy, interactive flows, or styling is **human-gated**:

1. **Do not autonomously invent or redesign UI** inside a background worker or [`skills/dispatch/SKILL.md`](../skills/dispatch/SKILL.md) run.
2. **Mockup or explicit spec first:**
   Before modifying production UI components or stylesheets (`*.css`, `*.scss`, `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, or HTML templates), either:
   - Cite the user's explicit specification from the current conversation, or
   - Propose the layout/interaction change (using a static HTML mockup comparison when exploring visual options) and wait for approval.
3. **Mechanical verification does not replace visual inspection:**
   Passing unit tests or DOM assertions is necessary but not sufficient for visual changes;
   highlight the exact visual delta for user review.
