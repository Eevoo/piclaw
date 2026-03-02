# Long-term Memory

This file stores important information that should persist across sessions.

## User Information

(Important facts about the user)

- Prefers agent behavior that writes story output to disk and follows procedural naming conventions for retries.


## Preferences

- When doing interactive storytelling, the agent must save narrative scene text to disk under readwrite/stories/<storyname>/text/ as sequential markdown files (0.md, 1.md, ...).
- If the story name is unknown, ask the user before saving files.
- When the user requests a redo of the last response, save the regenerated scene using retry suffixes (e.g., X-a.md, X-b.md) where X is the original response number; once a scene is accepted, the next file number increments.


## Project Context

- Skills created:
  - interactive-story
    - Purpose: Provide interactive storytelling behavior that persists scene text to disk and follows the user's naming/retry rules.
    - File: skills/interactive-story/SKILL.md
    - Key rules: always reply with the generated story scene even after writing the file; request story name if unknown; write to readwrite/stories/<storyname>/text/ as sequential .md files; use retry naming scheme for regenerations.
  - scenario-beatchart
    - Purpose: Generate a beat chart (ordered list of narrative/gameplay beats) for scenario-style stories (used for scenario/story planning and tabletop scenarios).
    - File: skills/scenario-beatchart/SKILL.md
    - Core algorithm/rules:
      - Beat granularity: ~0.5 hours per beat.
      - Structure: hook → alternating development/cliffhanger pairs → climax → resolution.
      - Hook, climax, and resolution each count as 1.5 hours toward total playtime; remaining time is divided between developments and cliffhangers.
    - Hook options (added): kidnapping, variation of cliffhanger (fast start), variation of development (slow start), discovery, ongoing crisis, revelation that changes lives, murder, false accusation, looming antagonist threat, and other user-specified hook types.
    - Cliffhanger types (added; rule: reserve best cliffhanger for last): chases, pursuit, race, fist fight, dogfight (mounted/combat-vertical hazard), confrontation (non-physical/verbal), duel (one-on-one), battles (full-scale), ambush, monster (scare/horror), obstacles (traps/natural hazards), contest (ritual/game/puzzle), skirmish (small battle where main villain often escapes).
    - Development types (added): warnings, hidden weakness, revelation (non-outcome-changing unveiling), advantage revealed, clues (ambiguous partial revelations), retreat (opponents fall back), hesitation (antagonists pause/negotiation), mistaken identity (important for plot), villain's monologue, secret meeting (may lead to ally/info and can be broken up by ambush), personal stakes (character poisoned/kidnapped or situation made personal), second chance (opportunity to retry a failed problem), new allies (appear with new information or clues), gain mastery (teaching/improvement/training montage granting skills), alliance (external help that is not itself decisive), betrayal (betrayal with chance to stop or catch soon after), sabotage (important device/vehicle disabled with chance to detect/repair/avert), foreshadowing (ambiguous warnings of events to come; shouldn't immediately precede the event), strange bedfellows (compelling forced alliance with usual opposition), turnabout (an antagonist aids the party for their own reasons), romance (romantic development), lie revealed (previously believed clue or vital datum is shown false, without revealing the full truth), hazardous quest (traps, pitfalls, slogging to destroy/find/recover something), puzzle (riddles or problems that must be solved to proceed; not a contest with an opponent), framed (character set up for a crime; obvious to others but authorities are convinced otherwise), obsession (a character is targeted by another's obsessive attention—love, hate, curiosity—that persists without direct confrontation), rescuers (mission to save someone from capture/death/confinement for compelling reasons), vengeance (a character singled out for antagonists' targeted revenge).
    - Notes: The user is actively building a comprehensive taxonomy of development types; entries have been appended iteratively to skills/scenario-beatchart/SKILL.md. The assistant has edited the SKILL.md multiple times to include these development types and offered to add micro-prompts per development type or to add beat metadata fields (stakes, NPCs, environment, consequences).


## Important Notes

- The user expects the agent to create and refine skills as discrete SKILL.md files under the skills/ directory; the assistant has already written and edited skills/interactive-story/SKILL.md and skills/scenario-beatchart/SKILL.md.
- The scenario-beatchart skill should provide options to generate beat charts from total playtime and support output formats (json or md) and persistence when requested.

---

*This file is automatically updated by nanobot when important information should be remembered.*