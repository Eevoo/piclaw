Skill: editorial-house

Purpose:
- Define an editorial house style for producing story and setting content.
- Enforce procedures that create the illusion of historical depth and ensure internal consistency across scenes, concepts, and plot elements.

Core principles:
1) Sense of history and depth
- Text should read as if the world has a past: place names, institutions, cultural practices, artifacts, and offhand references should suggest a larger history.
- When a concept (person, item, place, institution, law, legend, technology, event, or term) is created or referenced in that illusion of completeness, it MUST be recorded as a tracked concept.
- Tracked concepts enable internal cross-checking, discovery of contradictions, and later use as hooks or seeds for future material.

2) Internal consistency and plot-impact accountability
- Internal inconsistency or unexplained concepts that materially affect the plot are major editorial failures.
- Aim for internal consistency by default: reuse and reference known concepts whenever possible rather than inventing similar-but-different items without reason.
- If a newly-introduced concept will affect the plot downstream, its existence and function must be logically defended and recorded (see procedures below).

Concept tracking: path, naming, and content
- Storage path (required): readwrite/story/<storyname>/concepts/<name>.md
  - The file must contain a brief explanation of why the concept was created, where it is referenced from (scene/file path or beat), and what is known about it.
  - Filename conventions: lowercase, use hyphens for spaces, avoid punctuation. Example: readwrite/story/red-warden-tribute.md
- NOTE (inconsistency alert): The project's interactive-story preference stored in memory uses readwrite/stories/<storyname>/text/ for scene output. Confirm which top-level folder you want: readwrite/story/ (singular) for concepts as the user requested just now, or readwrite/stories/ (plural) to match existing story scene conventions.

Concept file template (markdown)
- Suggested canonical template to place at the top of each concept md file:

---
name: <canonical-name>
slug: <filename-slug>
created_by: <author or tool>
created_at: <ISO datetime>
status: provisional | confirmed | retconned | deprecated
source_scene: <path or beat reference where introduced>
related_concepts: [comma-separated slugs]
---

# Summary
A concise (2–4 sentence) explanation of the concept and why it exists.

# Why created
Short note on the authorial/intention reason this was added (tone, mechanics, hook, world-building).

# Where referenced
List of scene files/beats/pages that reference this concept, with short quotes or line pointers.

# Known facts
Bullet list of canonical facts about the concept (dates, appearance, abilities, allegiances). Facts should be concrete and verifiable in text.

# Plot implications
If this concept affects story outcomes or future beats, explain the mechanism and the logical justification.

# Notes / future hooks
Optional: ideas for how this can be used later, unresolved questions, contradictions to watch for.

# Revision history
- <ISO date> — <author> — created


Procedures for editorial authors and tools
- Before introducing a named concept in prose or a beat, check for an existing concept file at readwrite/story/<storyname>/concepts/<slug>.md. If it exists, reuse the canonical name and facts, or update the file with any new canonical details.
- If no file exists, create one using the template above. Populate source_scene and initial known facts. Record at least one reason it was created and where it is first referenced.
- If an existing concept must change in a way that affects earlier scenes (retcon), annotate the concept file with a clear rationalization, add a status: retconned, and list all scenes that must be reviewed. Notify the user before automated edits to existing scenes.
- If a concept is introduced casually (offhand reference) but later becomes plot-critical, immediately rationalize it ("why does this exist?") and add plot_implications and related_concepts entries.
- For ambiguous or intentionally-limited information (mystery elements), state explicitly what is unknown and what narrative purpose the ambiguity serves.

Consistency enforcement rules (editorial checks)
- Automated checks or human editors should verify:
  - No two concept files claim mutually-exclusive canonical facts about the same named entity.
  - Scenes that rely on a concept that would be surprising to the audience include an in-text cue or a prior reference (don't drop critical facts out of the blue).
  - If a concept will change the stakes or outcomes later, a supporting chain of facts/explanations exists in concept files or earlier scenes.

Retcon handling and dispute resolution
- Small clarifications (non-plot-changing) can be appended to concept files with a dated note.
- Major changes that alter plot outcomes require a retcon process: mark status: retconned, describe the reason, and tag scenes for revision. Inform collaborators and obtain approval before altering published scene text.

Cross-references and linking
- Always link concept files from scenes that reference them using relative paths. Provide a short parenthetical summary on first mention ("the Red Warden — a tribute paid each winter by the southern clans; see concepts/red-warden-tribute.md").
- When exporting or printing scenes that will be consumed without access to the concept files, include a short glossary appended to the document.

Tone and craft notes
- Aim for an illusion of completeness without overloading text with exposition. Let details breathe: use offhand references and small cultural flourishes to imply depth.
- Prefer concrete sensory details over broad statements ("weathered brass plaque" beats "an old monument").
- Use the concept files to store deeper lore that can be revealed later; avoid burying crucial facts in comments or private notes.

Implementation hooks for tools and other skills
- When the interactive-story skill writes a new scene file it should call this skill or follow these procedures:
  - Confirm storyname. If unknown, request it from the user.
  - Scan the scene for named concepts. For each, check and update or create concept md files under readwrite/story/<storyname>/concepts/.
  - If a concept is introduced that will materially affect the plot later, prompt the author for the plot implications and a short justification to be stored in the concept file.
- Provide a command-line helper or simple API for creating concept files from prompts using the canonical template.

Questions and choices for the user
- Which directory root do you want for story content and concepts: readwrite/story/ (as you specified now) or readwrite/stories/ (to match existing interactive-story memory preference)?
- Do you want automated enforcement (tooling that fails scene save if concept files are missing) or softer warnings when a concept isn't tracked?


End of skill.
