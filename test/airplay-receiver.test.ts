import { describe, it, expect } from "vitest";
import { receiverName } from "../src/airplay/receiver.js";

describe("receiverName", () => {
  it("substitutes boatName and zoneName into the pattern", () => {
    expect(receiverName("{boatName} - {zoneName}", "Tinarasia", "AirPlay")).toBe(
      "Tinarasia - AirPlay",
    );
  });

  it("leaves a pattern with no placeholders untouched", () => {
    expect(receiverName("Boat Audio", "Tinarasia", "AirPlay")).toBe(
      "Boat Audio",
    );
  });
});
