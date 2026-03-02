Skill: map-making

Purpose:
- Provide a compact, practical rulebook and checklist for designing "modified Earth" style world maps used in stories, tabletop games, and setting design.
- Capture geological, hydrological, climatological, settlement, and logistics rules of thumb to create believable maps that read as realistic while remaining game-friendly.

Assumption: "Modified Earth"
- The world behaves like Earth in broad physical ways (gravity, plate tectonics, hydrology, climate systems) but locations, continents, cultures, and history may be fictional.
- Use Earth-like percentages and constraints as a baseline; deviate intentionally and document the reason in the story's concept tracker.

Global statistics (baseline heuristics)
- Oceans: ~70% of surface area. Oceans contain ~97% of total planetary water.
- Fresh water: ~1% of water is readily fresh liquid; another ~2–3% is locked in glaciers and ice.
- Mountains: ~25% of land surface is mountains/ranges (mountains typically occur in ranges, not isolated).
- Plains: ~50% of land surface.
- Forests: ~30–40% of land surface.

Hydrology and rivers
- Water flows downhill from mountain sources to lakes or oceans.
- Lakes usually have one main river draining out and may have one or several small inflows; multiple small lakes can string together like beads along a river course.
- Rivers join (confluence), they do not split upstream. Exceptions occur in deltas or engineered canals downstream of the confluence.
- Rivers never loop back on themselves (no natural river loops).
- No river flows coast-to-coast across a major landmass; continental-crossing rivers are very rare and require special tectonic/topographic justification.
- Rivers rarely flow through deserts; if a river crosses a desert, its source originates far away (mountains, distant lakes, or perennial springs).
- Deltas and estuaries are where rivers may bifurcate and create marshes; these are biologically productive and prime settlement sites.

Mountains and tectonics
- Mountains tend to occur in ranges (linear or arcuate belts) produced by plate boundaries, uplift, or volcanism.
- Volcanoes and mountain chains cluster along tectonic margins.
- Mountain ranges create rain shadows: one side is wetter, the leeward side drier or barren.
- Supercontinents have very arid interiors and extreme continentality; coastal regions are more temperate and habitable.

Continents, islands, and coasts
- Continents clump together (archipelagos and continental shelves nearby); long, isolated islands far from continents are less common.
- Islands are usually near continental margins or island arcs rather than uniformly scattered across oceans.
- Coasts are irregular: bays, estuaries, peninsulas, and fjords create natural harbors and settlement opportunities.

Biomes and climate placement
- Rainfall and climate follow altitude, latitude, and prevailing winds; use mountain rain shadows and ocean currents to place deserts and forests.
- Forest cover: ~30–40% of land; place forests where precipitation and soils permit sustained tree growth (coastal temperate zones, river valleys, mountains with sufficient moisture, tropical belts).
- Deserts form on leeward sides of ranges and in interior continental zones.
- Plains (grasslands) make up roughly half the terrestrial surface and act as population and travel corridors.

Settlements and infrastructure
- Settlements cluster near reliable fresh water (rivers, lakes, springs) or within ~80 km of the coast when other freshwater sources exist.
- Port cities: commonly set slightly inland from the immediate shoreline (on river mouths, sheltered bays, or protected harbors) rather than directly on exposed coasts.
- Settlements cluster around natural resources: fresh water, arable land, mineral deposits, timber, and defensible terrain.
- Every settlement requires a food source. Rule of thumb: 1.5 acres (~0.6 hectares) of productive land per person for subsistence agriculture; adjust for technology and trade.
- Settlements require defenses — manmade walls or natural features (cliffs, rivers, marshes). Even small villages will choose defensible positions when danger is plausible.
- Roads link larger settlements and follow paths of least resistance: valleys, river corridors, coastal routes, and passes. Roads rarely cut straight across mountain ranges without major engineering.
- National and political boundaries tend to follow natural boundaries: rivers, mountain crests, coasts, and lakes.

Population distribution and resources
- Population density clusters along coasts, river valleys, and fertile plains; interior arid zones and high mountains are sparsely populated.
- Resource exploitation drives settlement patterns: mines near mountains, timber near forests, fisheries near productive coasts and estuaries.

Rivers and lakes as design constraints and tools
- When drawing rivers, pick mountain sources and draw downhill to lakes or oceans; avoid drawing rivers that cross entire continents without geological justification.
- Prefer confluences over splits: draw tributaries joining a mainstem river.
- Use stringed lakes as scenic/functional elements: a river flows into lake A, out to river B, into lake C, etc., like beads on a chain.
- Deltas and estuaries should be wider, marshy, and excellent for ports; big deltas can obscure precise river mouths across centuries.

Islands and archipelagos
- Island chains commonly form along volcanic arcs or continental shelves; place them near larger landmasses when plausible.
- Remote islands far from continents are rarer; when used, give them a lore justification (tectonic hotspot, continental fragment, or narrative isolation).

Practical map-making workflow (checklist)
1. Define scale and projection: choose map scale (local, regional, continental) and projection appropriate for shape preservation.
2. Block in large features: oceans, continental outlines, mountain belts, major plate boundaries, and principal rivers.
3. Place rain shadows and major biomes using prevailing wind patterns, latitude, and mountain locations.
4. Sketch river networks from mountain sources to sinks (lakes/oceans). Ensure rivers join, not split upstream.
5. Carve in coasts, estuaries, bays, and deltas. Locate likely ports slightly inland on sheltered water.
6. Add plains, forests, deserts according to precipitation and soil heuristics.
7. Position settlements: near water, resources, and defensible terrain; cluster towns into networks connected by roads.
8. Place infrastructure: roads follow easiest routes; bridges at narrow crossings; passes cut into mountains where needed.
9. Iterate: test hydrology and population distribution; fix unrealistic coast-to-coast rivers, impossible island placements, or isolated resources.

Documentation and concept-tracking
- Record major named features as tracked concepts in the editorial system (see editorial-house skill): mountain ranges, rivers, lakes, coasts, major cities, and unique biomes.
- For each tracked feature record: why it was created, geological justification, source scenes that reference it, and any plot implications.

Exceptions and deliberate deviations
- You may intentionally deviate from these rules for narrative reasons (fantasy geology, magic rivers, plate tectonic anomalies). When you do, document the exception and its in-universe cause.
- If a river splits upstream (e.g., mythical bifurcation) or islands float, give a clear in-world mechanism and record it in concept files to avoid contradictions.

Implementation hooks for tool builders
- Parameters to expose to map generators:
  - scale_km_per_unit, ocean_coverage (default 0.7), mountain_coverage (default 0.25 of land), forest_fraction (0.3–0.4), freshwater_percent (approx 0.01), glacier_percent (0.02–0.03), settlement_proximity_km (80), food_acres_per_person (1.5).
  - genre_bias / density_bias to control settlement clustering and infrastructure density.
- Generator behaviors:
  - Enforce river topology rules (acyclic graph with confluences only upstream).
  - Validate that river sources are upslope of sinks; check that no river crosses the entire continent without justification.
  - Recommend port placement at sheltered inlets or river mouths slightly inland; warn if a major city is placed on an exposed, unprotected coastline.
  - Provide a "reality score" for maps that flags violations: coast-to-coast rivers, isolated islands far from continents, unrealistic percentage coverage mismatches.
- File organization suggestions:
  - readwrite/maps/<mapname>/metadata.json (scale, projection, generator parameters)
  - readwrite/maps/<mapname>/terrain.svg or .png
  - readwrite/maps/<mapname>/features.csv (name, type, coordinates, notes)
  - readwrite/maps/<mapname>/concepts/<feature-slug>.md (link into editorial-house concept tracker)

Craft notes and artistic guidance
- Use human-scale landmarks to sell believability: ruins, named passes, river bridges, localized microclimates.
- Small, sensible details (a mill at a river bend, a ferry crossing, a seasonal flood plain) make the map read as lived-in.
- Avoid overcrowding maps with labels; use concept files for deep lore and reserve maps for spatial clarity.

End of skill.
