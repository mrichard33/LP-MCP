## Summary

<!-- What changed and why. Name the incident or ruling it comes from. -->

## Test plan

<!-- npm test, plus any script output a reviewer needs. -->

## Bot gate (required on any bot, prompt, planner or guard change)

Gate job id:
Scenario(s) added:
Rule home (prompt | planner | guard | policy):

<!--
Gate job id: the run_bot_eval job after this change (sim_…). It must not read
"WORSE THAN LAST RUN".
Scenario(s) added: the SCENARIOS key(s) in src/simulator/bot-simulator.js that
show the fix, or "none" with a reason.
Rule home: where the rule lives. One home per rule.
A prompt copy change also bumps RESPONSE_GENERATOR_VERSION.
-->
