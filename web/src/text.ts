// Small wording helpers shared by every page.

/** "1 flag", "2,048 flags", "3 people" (pass the plural when it isn't just "+s"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
