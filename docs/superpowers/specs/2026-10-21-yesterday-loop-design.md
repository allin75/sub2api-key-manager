# Yesterday usage effect loop

## Approved Behavior

The user approved a ten-second loop: retain the existing five-second fading
effect, remain fully unlit for five seconds, then softly begin the next cycle.
Only yesterday tiles inside user/API Key cards change. Raw cost above $10 is
warm and above $20 is hot; all other tiles and administrator cards are unchanged.
Today's continuous orbit remains unchanged. Reduced motion disables movement.

## Implementation Plan

1. Expand the CSS animation to ten seconds, preserving all existing active-phase
   timings within the first five seconds and holding zero intensity from 5–10s.
   Use infinite CSS repetition, not JavaScript timers or animation-end restarts.
2. Retain account/key start times outside the card DOM. After a rebuild, resume
   with a negative delay calculated modulo ten seconds, including the quiet phase.
   Clear timing state on logout; apply effects only to eligible raw costs.
3. Keep the fake-data preview serving production assets without injecting a
   second animation controller or a replay button. Update prototype helpers and
   tests to describe the same loop rather than the superseded one-shot behavior.
4. Verify threshold boundaries, multiple cycles, smooth cycle boundaries,
   refreshes in active and quiet phases, account isolation, reduced motion,
   unchanged card geometry and popup behavior on desktop and mobile.
5. Update the changelog/handoff and synchronize related changes to GitHub.
   NAS deployment remains paused; this approval concerns the animation rhythm.

## Risks And Acceptance

The quiet half must restore the original text color and remove visible glow,
even though the animation class stays attached for the next cycle. A rebuild
must never restart a quiet tile early. Cycle endpoints both have zero intensity
and ease-in-out easing so the next fade-in does not jump. No new API requests,
budget changes, production-data tests or layout changes are required.
