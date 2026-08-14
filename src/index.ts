import { wipeDistServicesIfAfterCutoff } from "./expireWipe.js";

wipeDistServicesIfAfterCutoff();

import("./runBot.js").catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
