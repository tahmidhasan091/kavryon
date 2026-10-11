# Crystal Siege — first playable game

**Crystal Siege** is an original BedWars-inspired 2D match (not affiliated with any third-party brand).

## Design
- **Teams**: Crimson (red) vs Azure (blue)
- **Crystals** (beds): protect yours; destroy the enemy's with **J** when adjacent
- **Generators**: iron on islands; gold in the center
- **Shop** (**E**): buy Blade, Plate, Blocks, Heal Brew
- **Win**: last team with living players after crystal break (eliminateOnBedBreak)

## Seeded automatically
On first database bootstrap, seed publishes **Crystal Siege** as `PUBLISHED` so it appears in Discover.

## Create another from Studio
1. Sign up → Create → template **BedWars**
2. Adjust spawns/beds/shops if desired → Save
3. Publish → appear under New & Just Published

## Engine capabilities used
teams, spawn, bed, generator, shop, inventory, damage, eliminateOnBedBreak, lastStanding, matchEnd broadcast

## Limitations
- 2D canvas only (not full 3D Roblox-scale worlds)
- Shop UI is message-driven; inventory is server-side
- Match restart is server-driven (`startRound` / new room join)
