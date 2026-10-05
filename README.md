# TEND

An interactive campfire that behaves as an emergent system. You are camping in a forest and have to keep the fire going from 11:00 PM until sunrise at 6:00 AM (about 150 seconds).

**The player controls conditions, not outcomes.**

## Concept

An interactive campfire simulation where the player manipulates fuel, and environmental conditions indirectly shape the outcome.

There is no "fire health" number anywhere in the code. The fire exists only because individual pieces of fuel are burning and heating each other. The player can do exactly one thing: choose a piece of fuel and where to put it. Wind and moisture drift on their own through the night.

## How to play

- Drag dry leaves, twigs or logs from the bottom of the screen onto the ground.
- Fuel that has not caught yet can be picked up and moved. Once it is burning it is locked.
- New fuel is as damp as the night air. Setting it near the fire dries it before it is needed.
- You lose if nothing is burning for 9 seconds, or if a fire establishes itself outside the stone ring.
- You win if something is still burning at 6:00 AM.
- Press `D` for a debug view. Point at any piece to see its temperature, ignition point, oxygen, fuel and dampness.

## Base rules

Every piece of fuel follows the same ten rules, many times a second.

1. Everything slowly loses heat to the night air.
2. Burning fuel heats nearby fuel. Closer means more heat.
3. Heat dries damp fuel first. Only what is left over warms it.
4. Fuel ignites when it gets hot enough. Damp fuel needs to get hotter.
5. Burning uses up fuel and produces heat.
6. Burning fuel sometimes throws a spark.
7. Wind pushes heat, flames, smoke and sparks downwind.
8. Fuel packed too tightly shares its air and burns weakly.
9. Fuel stops burning when it gets too cold or runs out.
10. A spark gives its remaining heat to whatever fuel it lands on.

The three materials are the same object with different numbers:

| | Catches | Burns for | Alone |
|---|---|---|---|
| Dry leaves | very easily | a few seconds | flares and is gone |
| Twigs | fairly easily | about 20 seconds | just keeps itself going |
| Logs | only with a lot of heat | about a minute | cools and goes out |

The forest floor outside the ring is scattered with leaf litter and tiny twigs. They are ordinary fuel and follow the same ten rules.

## Emergence

None of the following is written in the code as an event. Each one comes out of the ten rules repeating.

- **Stable fire structures emerge from heat sharing versus airflow.** A log on its own loses heat faster than it makes it (rules 1 and 5), so it dies. Two or three logs close together keep each other above the line (rule 2). Push them too close and they choke (rule 8). The arrangement that works is one the player finds by trying.
- **Ignition chains emerge from local heat transfer.** One leaf cannot light a twig and leaves cannot light a log, but a few leaves light a twig and a few twigs light a log. Nothing in the code describes kindling.
- **Fire shapes emerge from where the fuel is.** Every flame particle is born from one burning piece, sized by how strongly that piece is burning. There is no flame shape anywhere in the code.
- **Environmental variation changes behaviour.** Wind sends heat one way, so a new log catches on the downwind side and may not catch upwind. On a damp night the same arrangement takes longer to light.
- **Wildfire emerges from sparks meeting ordinary ground material.** A spark is thrown (rule 6), carried by the wind (rule 7), lands on a dry leaf outside the ring and gives it heat (rule 10). If that is enough the leaf ignites (rule 4) and heats its neighbours (rule 2). A patch of litter may flare and burn itself out, or pass the fire on.
- **More fire is not always better.** A big fire burns through the wood before dawn and throws more sparks while it does.

Win and lose are measurements. The code counts what is burning and where; it never causes a fire or puts one out.

## The animation is the simulation

- Flame particles are spawned from each burning piece in proportion to its heat. A weak piece gives low, thin flames; a hot one gives tall ones.
- The glow on the ground is one soft pool of light per burning piece. The large warm glow is those pools adding up.
- The sparks on screen are the same objects that carry heat in the simulation.
- A choked fire makes more smoke than a clean one.
- Fuel colour shows its state: damp is darker, warming fuel glows red, burnt fuel chars.

Smoke, stars, trees, the tent and the sky are visual only.

## Files

```
index.html   the page: canvas plus a few lines of text
style.css    the look of the text layer
script.js    everything else, in seven commented sections
README.md    this file
```

## Running it

Open `index.html` in a browser.
