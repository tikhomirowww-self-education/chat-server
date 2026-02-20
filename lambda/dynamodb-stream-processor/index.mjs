/**
 * DynamoDB Streams processor for chat side effects.
 *
 * This Lambda does not replace Nest CRUD. It reacts to changes and is intended
 * for async workflows (notifications, analytics, moderation, audit trails).
 */
export const handler = async (event) => {
  const records = event?.Records ?? [];

  for (const record of records) {
    const eventName = record.eventName;
    const keys = record.dynamodb?.Keys ?? {};
    const newImage = record.dynamodb?.NewImage ?? {};

    const pk = getStringAttr(keys.PK);
    const sk = getStringAttr(keys.SK);
    const entity = getStringAttr(newImage.entity);

    // Message created in a room: emit a background "notification" event.
    if (eventName === "INSERT" && entity === "MESSAGE") {
      const roomId = getStringAttr(newImage.roomId);
      const userId = getStringAttr(newImage.userId);
      const text = getStringAttr(newImage.text);
      const createdAt = getStringAttr(newImage.createdAt);

      console.log(
        JSON.stringify({
          type: "chat.message.created",
          roomId,
          userId,
          textPreview: text.slice(0, 120),
          createdAt,
          pk,
          sk,
        }),
      );
      continue;
    }

    // New membership (group invite / direct room participant):
    if (eventName === "INSERT" && entity === "MEMBERSHIP") {
      const roomId = getStringAttr(newImage.roomId);
      const userId = getStringAttr(newImage.userId);
      const role = getStringAttr(newImage.role);

      console.log(
        JSON.stringify({
          type: "chat.membership.created",
          roomId,
          userId,
          role,
          pk,
          sk,
        }),
      );
    }
  }

  return {
    ok: true,
    processed: records.length,
  };
};

function getStringAttr(attr) {
  if (!attr) return "";
  if (typeof attr.S === "string") return attr.S;
  return "";
}
