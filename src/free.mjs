// The programs are free (owner, 15 Oct 2026): StitchBench and StitchShop cost nothing, and a YouTube channel and donations
// pay for them. While this is on (the default), every shop's standing is "comped" with a key that runs to 2099 (the same
// standing and key the admin's comp gives, so every program already out there understands it), every add-on is covered,
// and no subscription can be started. The admin's "Lapse now" still ends a shop (abuse). Set PROGRAM_FREE=off to bring
// the plans, the trial and the prices back (the test suites that check billing do). The Assistant (it costs money for
// every question) is not part of this: it keeps its own subscription.
export const freeProgram = () => !/^(off|0|false|no)$/i.test((process.env.PROGRAM_FREE ?? "").trim());
