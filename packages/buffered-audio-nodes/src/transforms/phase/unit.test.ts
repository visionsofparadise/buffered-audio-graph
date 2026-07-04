import { describe, it, expect } from "vitest";
import { runTransform } from "../../utils/test-pipeline";
import { notSilent, expectedDuration, notAnomalous } from "../../utils/test-audio";
import { audio } from "../../utils/test-binaries";
import { phase } from ".";

const testVoice = audio.testVoice;

describe("Phase", () => {
  it("processes voice audio", async () => {
    const transform = phase({ invert: true });
    const { input, output, context } = await runTransform(testVoice, transform);

    expect(notSilent(output).pass).toBe(true);
    expect(expectedDuration(output, context.durationFrames ?? 0).pass).toBe(true);
    expect(notAnomalous(output).pass).toBe(true);

    // Phase inversion negates samples — sum of squares is identical, so somethingChanged won't detect it.
    for (let i = 0; i < Math.min(100, input[0]?.length ?? 0); i++) {
      expect(output[0]?.[i]).toBeCloseTo(-(input[0]?.[i] ?? 0), 4);
    }
  }, 240_000);
});
