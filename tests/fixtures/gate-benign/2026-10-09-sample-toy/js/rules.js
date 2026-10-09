export function ruleTable(n) {
  return Array.from({ length: 8 }, (_, i) => (n >> i) & 1);
}
export function nextRow(row, table) {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const l = row[(i - 1 + row.length) % row.length];
    const c = row[i];
    const r = row[(i + 1) % row.length];
    out[i] = table[(l << 2) | (c << 1) | r];
  }
  return out;
}

/** Named rule 0: counts live neighbours in a window of 1 and compares with a threshold. */
export function window0(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 1: counts live neighbours in a window of 2 and compares with a threshold. */
export function window1(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 2: counts live neighbours in a window of 3 and compares with a threshold. */
export function window2(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 3: counts live neighbours in a window of 4 and compares with a threshold. */
export function window3(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 4: counts live neighbours in a window of 5 and compares with a threshold. */
export function window4(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 5: counts live neighbours in a window of 1 and compares with a threshold. */
export function window5(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 6: counts live neighbours in a window of 2 and compares with a threshold. */
export function window6(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 7: counts live neighbours in a window of 3 and compares with a threshold. */
export function window7(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 8: counts live neighbours in a window of 4 and compares with a threshold. */
export function window8(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 9: counts live neighbours in a window of 5 and compares with a threshold. */
export function window9(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 10: counts live neighbours in a window of 1 and compares with a threshold. */
export function window10(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 11: counts live neighbours in a window of 2 and compares with a threshold. */
export function window11(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 12: counts live neighbours in a window of 3 and compares with a threshold. */
export function window12(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 13: counts live neighbours in a window of 4 and compares with a threshold. */
export function window13(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 14: counts live neighbours in a window of 5 and compares with a threshold. */
export function window14(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 15: counts live neighbours in a window of 1 and compares with a threshold. */
export function window15(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 16: counts live neighbours in a window of 2 and compares with a threshold. */
export function window16(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 17: counts live neighbours in a window of 3 and compares with a threshold. */
export function window17(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 18: counts live neighbours in a window of 4 and compares with a threshold. */
export function window18(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 19: counts live neighbours in a window of 5 and compares with a threshold. */
export function window19(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 20: counts live neighbours in a window of 1 and compares with a threshold. */
export function window20(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 21: counts live neighbours in a window of 2 and compares with a threshold. */
export function window21(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 22: counts live neighbours in a window of 3 and compares with a threshold. */
export function window22(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 23: counts live neighbours in a window of 4 and compares with a threshold. */
export function window23(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 24: counts live neighbours in a window of 5 and compares with a threshold. */
export function window24(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 25: counts live neighbours in a window of 1 and compares with a threshold. */
export function window25(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 26: counts live neighbours in a window of 2 and compares with a threshold. */
export function window26(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 27: counts live neighbours in a window of 3 and compares with a threshold. */
export function window27(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 28: counts live neighbours in a window of 4 and compares with a threshold. */
export function window28(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 29: counts live neighbours in a window of 5 and compares with a threshold. */
export function window29(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 30: counts live neighbours in a window of 1 and compares with a threshold. */
export function window30(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 31: counts live neighbours in a window of 2 and compares with a threshold. */
export function window31(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 32: counts live neighbours in a window of 3 and compares with a threshold. */
export function window32(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 33: counts live neighbours in a window of 4 and compares with a threshold. */
export function window33(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 34: counts live neighbours in a window of 5 and compares with a threshold. */
export function window34(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 35: counts live neighbours in a window of 1 and compares with a threshold. */
export function window35(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 36: counts live neighbours in a window of 2 and compares with a threshold. */
export function window36(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 37: counts live neighbours in a window of 3 and compares with a threshold. */
export function window37(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 38: counts live neighbours in a window of 4 and compares with a threshold. */
export function window38(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 39: counts live neighbours in a window of 5 and compares with a threshold. */
export function window39(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 40: counts live neighbours in a window of 1 and compares with a threshold. */
export function window40(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 41: counts live neighbours in a window of 2 and compares with a threshold. */
export function window41(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 42: counts live neighbours in a window of 3 and compares with a threshold. */
export function window42(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 43: counts live neighbours in a window of 4 and compares with a threshold. */
export function window43(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 44: counts live neighbours in a window of 5 and compares with a threshold. */
export function window44(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 45: counts live neighbours in a window of 1 and compares with a threshold. */
export function window45(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 46: counts live neighbours in a window of 2 and compares with a threshold. */
export function window46(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 47: counts live neighbours in a window of 3 and compares with a threshold. */
export function window47(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 48: counts live neighbours in a window of 4 and compares with a threshold. */
export function window48(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 49: counts live neighbours in a window of 5 and compares with a threshold. */
export function window49(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 50: counts live neighbours in a window of 1 and compares with a threshold. */
export function window50(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 51: counts live neighbours in a window of 2 and compares with a threshold. */
export function window51(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 52: counts live neighbours in a window of 3 and compares with a threshold. */
export function window52(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 53: counts live neighbours in a window of 4 and compares with a threshold. */
export function window53(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 54: counts live neighbours in a window of 5 and compares with a threshold. */
export function window54(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 55: counts live neighbours in a window of 1 and compares with a threshold. */
export function window55(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 56: counts live neighbours in a window of 2 and compares with a threshold. */
export function window56(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 57: counts live neighbours in a window of 3 and compares with a threshold. */
export function window57(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 58: counts live neighbours in a window of 4 and compares with a threshold. */
export function window58(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 59: counts live neighbours in a window of 5 and compares with a threshold. */
export function window59(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 60: counts live neighbours in a window of 1 and compares with a threshold. */
export function window60(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 61: counts live neighbours in a window of 2 and compares with a threshold. */
export function window61(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 62: counts live neighbours in a window of 3 and compares with a threshold. */
export function window62(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 63: counts live neighbours in a window of 4 and compares with a threshold. */
export function window63(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 64: counts live neighbours in a window of 5 and compares with a threshold. */
export function window64(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 65: counts live neighbours in a window of 1 and compares with a threshold. */
export function window65(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 66: counts live neighbours in a window of 2 and compares with a threshold. */
export function window66(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 67: counts live neighbours in a window of 3 and compares with a threshold. */
export function window67(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 68: counts live neighbours in a window of 4 and compares with a threshold. */
export function window68(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 69: counts live neighbours in a window of 5 and compares with a threshold. */
export function window69(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 70: counts live neighbours in a window of 1 and compares with a threshold. */
export function window70(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 71: counts live neighbours in a window of 2 and compares with a threshold. */
export function window71(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 72: counts live neighbours in a window of 3 and compares with a threshold. */
export function window72(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 73: counts live neighbours in a window of 4 and compares with a threshold. */
export function window73(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 74: counts live neighbours in a window of 5 and compares with a threshold. */
export function window74(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 75: counts live neighbours in a window of 1 and compares with a threshold. */
export function window75(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 76: counts live neighbours in a window of 2 and compares with a threshold. */
export function window76(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 77: counts live neighbours in a window of 3 and compares with a threshold. */
export function window77(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 78: counts live neighbours in a window of 4 and compares with a threshold. */
export function window78(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 79: counts live neighbours in a window of 5 and compares with a threshold. */
export function window79(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 80: counts live neighbours in a window of 1 and compares with a threshold. */
export function window80(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 81: counts live neighbours in a window of 2 and compares with a threshold. */
export function window81(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 82: counts live neighbours in a window of 3 and compares with a threshold. */
export function window82(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 83: counts live neighbours in a window of 4 and compares with a threshold. */
export function window83(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 84: counts live neighbours in a window of 5 and compares with a threshold. */
export function window84(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 85: counts live neighbours in a window of 1 and compares with a threshold. */
export function window85(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 86: counts live neighbours in a window of 2 and compares with a threshold. */
export function window86(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 87: counts live neighbours in a window of 3 and compares with a threshold. */
export function window87(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 88: counts live neighbours in a window of 4 and compares with a threshold. */
export function window88(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 89: counts live neighbours in a window of 5 and compares with a threshold. */
export function window89(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 90: counts live neighbours in a window of 1 and compares with a threshold. */
export function window90(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 91: counts live neighbours in a window of 2 and compares with a threshold. */
export function window91(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 92: counts live neighbours in a window of 3 and compares with a threshold. */
export function window92(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 93: counts live neighbours in a window of 4 and compares with a threshold. */
export function window93(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 94: counts live neighbours in a window of 5 and compares with a threshold. */
export function window94(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 95: counts live neighbours in a window of 1 and compares with a threshold. */
export function window95(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 96: counts live neighbours in a window of 2 and compares with a threshold. */
export function window96(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 97: counts live neighbours in a window of 3 and compares with a threshold. */
export function window97(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 98: counts live neighbours in a window of 4 and compares with a threshold. */
export function window98(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 99: counts live neighbours in a window of 5 and compares with a threshold. */
export function window99(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 100: counts live neighbours in a window of 1 and compares with a threshold. */
export function window100(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 101: counts live neighbours in a window of 2 and compares with a threshold. */
export function window101(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 102: counts live neighbours in a window of 3 and compares with a threshold. */
export function window102(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 103: counts live neighbours in a window of 4 and compares with a threshold. */
export function window103(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 104: counts live neighbours in a window of 5 and compares with a threshold. */
export function window104(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 105: counts live neighbours in a window of 1 and compares with a threshold. */
export function window105(row, index) {
  let live = 0;
  const radius = 1;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}

/** Named rule 106: counts live neighbours in a window of 2 and compares with a threshold. */
export function window106(row, index) {
  let live = 0;
  const radius = 2;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 3 ? 1 : 0;
}

/** Named rule 107: counts live neighbours in a window of 3 and compares with a threshold. */
export function window107(row, index) {
  let live = 0;
  const radius = 3;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 4 ? 1 : 0;
}

/** Named rule 108: counts live neighbours in a window of 4 and compares with a threshold. */
export function window108(row, index) {
  let live = 0;
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 1 ? 1 : 0;
}

/** Named rule 109: counts live neighbours in a window of 5 and compares with a threshold. */
export function window109(row, index) {
  let live = 0;
  const radius = 5;
  for (let d = -radius; d <= radius; d++) {
    live += row[(index + d + row.length) % row.length];
  }
  // Threshold chosen so the family of rules stays varied.
  return live >= 2 ? 1 : 0;
}
