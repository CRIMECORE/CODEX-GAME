import { clearBotStateTable } from '../index.js';

(async () => {
  await clearBotStateTable();
  process.exit(0);
})();
