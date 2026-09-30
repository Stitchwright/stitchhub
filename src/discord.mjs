// What the hub posts to the community's Discord channel. Whatever a member typed (a shop's name, a note's title, a link's
// brand) goes in as text: Discord would otherwise read it as markup, so [a name](https://elsewhere) would show a link
// to somewhere else, and @everyone or <@&role> would ping the whole server.

/** Text that shows as typed: Discord's markup characters get a backslash. */
export const discordText = (s) => String(s ?? "").replace(/[\\*_~`|>[\]()<@#]/g, "\\$&");

/**
 * The body to post for notify`...${member text}...` (the strings between the ${} are the hub's own, the values are
 * escaped), or for a plain string that is posted as it is. Nothing in it is allowed to ping anyone.
 */
export function discordBody(parts, values = []) {
  const text = Array.isArray(parts) ? parts.reduce((out, p, i) => out + p + (i < values.length ? discordText(values[i]) : ""), "") : String(parts);
  return { content: text.slice(0, 1900), allowed_mentions: { parse: [] } };
}
