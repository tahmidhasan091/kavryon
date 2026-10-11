# Kavryon Game Engine Report

## Architecture
- `backend/engine/definition.js` — schema + limits + sanitize
- `backend/engine/dsl.js` — restricted event/action executor (no eval/require/fs)
- `backend/engine/runtime.js` — server-authoritative GameRuntime
- `backend/engine/templates/*.json` — 13 starting templates
- `backend/multiplayer/roomManager.js` — hosts runtimes, ticks AI/generators

## Client protocol
INPUT only: left, right, jump, attack, interact, useItem, sequence
Server broadcasts: state, events, inventory, shop, quest, matchEnd

## Systems working in runtime
Physics/collision, teams, beds, generators, shops, inventory, combat, NPC AI, quests, XP/levels, checkpoints, finish, timers, win/lose, spectators

## Templates
Empty World, Obby, Platformer, Team Battle, BedWars, Survival, Racing, Tycoon, Simulator, RPG, Adventure, Horror, Arena

## Test games (engine-tests.js)
Obby, BedWars, RPG, Racing, Survival — all passed
