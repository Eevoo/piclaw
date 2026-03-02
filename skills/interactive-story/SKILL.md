Skill: interactive-story

Purpose:
- Provide interactive storytelling behavior for the agent.
- When the agent generates a story scene during an interactive session, the narrative text must be saved to disk in readwrite/stories/<storyname>/text/ as sequential markdown files (0.md, 1.md, ...).

Behavioral rules (must be followed by the agent):
1. Story-name discovery
   - If the agent does not know the canonical story name, it must ask the user for one before saving any files.
   - The user may provide a short filesystem-friendly name (letters, digits, hyphens, underscores). The agent should validate and, if needed, ask for a sanitized name.

2. File writing rules
   - Narrative text for each agent-generated scene must be saved to readwrite/stories/<storyname>/text/<N>.md where N is a zero-based integer for the first persisted scene for that story.
   - If the agent has previously saved scenes, the next file number is the first unused integer. Example: if 0.md and 1.md exist, next is 2.md.
   - After writing a scene file, the agent must re-open and read the file to confirm the write succeeded (and validate contents if necessary).

3. Reply behavior
   - The agent must always also include the full generated scene in its chat reply (i.e., do not only say "wrote file X"). The user wants to see the scene in the chat and have it persisted.

4. Redo / retries
   - If the user requests a redo of the agent's last response, the agent should generate a new scene and save it using a suffix on the last saved integer filename. For example, if the last saved file was 3.md, retries should be named 3-a.md, 3-b.md, 3-c.md, etc.
   - The original 3.md must be preserved unless the user explicitly asks to replace it.
   - After the user is satisfied with a scene (explicitly or by moving on to the next), the next successful scene write increments the integer: if the last final accepted scene was 3 (or 3-a/b if those were retries), the next new scene file should be 4.md.

5. Metadata and safety
   - The agent may optionally write a lightweight metadata file next to each scene (same folder) named <N>.json containing a small JSON object with at least: {"filename":"<N>.md","retry": false, "timestamp":"ISO-8601"}. For retry files use filename like "3-a.md" and retry:true.
   - Do not store any private user data beyond what the user agreed to keep in the story files.

6. File system constraints
   - Create directories as needed (readwrite/stories/<storyname>/text/).
   - Validate characters in filenames; replace or reject characters that are not letters, digits, hyphen, or underscore.

7. User interaction patterns
   - If the user says nothing about a story name and does not respond to prompts, the agent should not write files.
   - The agent should be explicit when a write occurs ("Saved scene to readwrite/stories/<storyname>/text/<N>.md") but also include the scene text in the reply.

Examples and edge-cases
- First scene for story "midnight-rose": write readwrite/stories/midnight-rose/text/0.md and include the scene in the reply.
- User says "no redo your last response": read the last numeric scene file index (e.g., 3.md) and create 3-a.md with the regenerated scene, but still respond with the new scene text. If user says "redo again" create 3-b.md, etc.
- If user asks to replace the previous file explicitly, the agent should confirm before overwriting.

Implementation notes for the agent
- Steps to create a scene file when asked/when generating a scene:
  1. Confirm or ask for storyname.
  2. Sanitize the storyname for filesystem use.
  3. Locate the directory readwrite/stories/<storyname>/text/ and list files to find the highest numeric N used (and whether there are retry files).
  4. If this is a new canonical scene: choose next integer N and write N.md.
  5. If this is a retry of the most recent scene: append an alphabetical suffix (a, b, c) to the last numeric filename.
  6. After writing, re-open and read the file to confirm.
  7. Reply with the scene text in chat and a short confirmation line listing the saved path.

- Always obey workspace safety rules (do not create files outside readwrite/ for this skill without explicit user permission).

Change-log
- 2026-03-02: initial creation per user request.
