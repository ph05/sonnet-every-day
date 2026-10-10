// Boot order from the interface contract: the UI listens first, then the game deals and announces the first state.
import { mountUI } from './ui.js';
import { createGame } from './game.js';

mountUI();
const game = createGame();
// Read-only hook for the browser check and the thumbnail step.
window.__jip = { version: 1, vm: () => game.vm() };
game.start(location.hash);
addEventListener('hashchange', () => game.start(location.hash));
