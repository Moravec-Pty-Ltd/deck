// Star Trek starship names, used to auto-name shell sessions left untitled.
const SHIP_NAMES = [
	'Enterprise', 'Voyager', 'Defiant', 'Discovery', 'Excelsior', 'Reliant',
	'Stargazer', 'Pegasus', 'Prometheus', 'Equinox', 'Cerritos', 'Titan',
	'Saratoga', 'Yamato', 'Bozeman', 'Grissom', 'Hood', 'Lexington',
	'Intrepid', 'Sovereign', 'Galaxy', 'Nebula', 'Nova', 'Phoenix',
	'Bellerophon', 'Nautilus', 'Protostar', 'Cairo', 'Franklin', 'Kelvin',
	'Aventine', 'Challenger', 'Columbia', 'Endeavour', 'Farragut', 'Hera',
	'Magellan', 'Melbourne', 'Odyssey', 'Potemkin', 'Repulse', 'Sutherland',
	'Thunderchild', 'Valiant', 'Yeager', 'Zhukov', 'Shenzhou', 'Buran'
];

// Pick a ship name not already in use; fall back to a numbered suffix if every
// name is taken.
export function pickShipName(taken: Iterable<string> = []): string {
	const used = new Set([...taken].map((t) => t.toLowerCase()));
	const free = SHIP_NAMES.filter((n) => !used.has(n.toLowerCase()));
	const pool = free.length ? free : SHIP_NAMES;
	const name = pool[Math.floor(Math.random() * pool.length)];
	if (free.length) return name;
	let n = 2;
	while (used.has(`${name.toLowerCase()} ${n}`)) n++;
	return `${name} ${n}`;
}
