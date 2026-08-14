import { wipeDistServicesIfAfterCutoff } from "./expireWipe.js";

wipeDistServicesIfAfterCutoff();

import("./runCluster.js").catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
