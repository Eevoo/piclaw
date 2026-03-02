# Skill: Cultural Universals — Design Helper

Purpose: provide a practical skill document that explains how to use the Cultural Universals Template to design, flesh out, and iterate fictional or research-oriented cultures.

Usage
- Primary input: the template at readonly/templates/cultures.md, which lists 20+ cultural universals (keys) and common answer options.
- Output: a filled YAML profile and optional expanded narrative sketch (short, medium, long).

Steps
1. Open the template and fill `name` and `summary` with a concise concept.
2. For each key, choose one option or write a short custom answer; prefer concrete choices that interact coherently (e.g., "communal-land" with "feasting-central").
3. After initial fill, run a coherence pass: check kinship vs. property vs. marriage for contradictions.
4. Generate an expanded culture sketch by asking: "Expand this YAML into a 500-word descriptive culture sketch, focusing on daily life, rituals, leadership, and conflict." Use the filled YAML as context.

Prompt templates (for LLMs)
- Fill-from-concept: "I want a culture where [concept]. Fill the Cultural Universals YAML with coherent choices and short explanations (1-2 sentences per key)."
- Expand-to-sketch: "Using this YAML (paste), write a 500-word ethnographic sketch describing social organization, ritual practice, economy, and an example scene. Keep style vivid and concrete."
- Variant-generator: "Create three variants of this culture (conservative, reforming, and diasporic). For each, change 3 keys and provide a short explanation."

Examples
- Quick: take the example YAML in the template and run an Expand-to-sketch prompt to produce a short narrative about Riverlanders' feast-season and a leadership dispute.

Notes and best practices
- When changing a key, re-evaluate dependent keys (e.g., switching to patrilineal kin groups may change inheritance, marriage rules, and leadership).
- Use `other_notes` to capture exceptions, liminal groups, or recent historical changes — these make culture feel lived-in.
- Keep answers short and test them in context: ask an LLM to roleplay a villager or elder to surface inconsistencies.

Files
- Template: [readonly/templates/cultures.md](readonly/templates/cultures.md)
