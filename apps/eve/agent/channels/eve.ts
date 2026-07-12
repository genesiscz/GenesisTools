import { eveChannel } from "eve/channels/eve";
import { serviceKeyAuth } from "../lib/service-key-auth";

export default eveChannel({
  // Service-key route protection — the eve-native equivalent of the youtube
  // server's `requireServiceKey`. Open when `EVE_SERVICE_KEY` is unset (so
  // `eve dev` and localhost are unaffected); requires `Authorization: Bearer
  // <key>` on `/eve/v1/session*` when set. `GET /eve/v1/health` stays public
  // and `/.well-known/workflow/*` is not a channel route, so both remain open.
  auth: [serviceKeyAuth()],
});
