/*
 * What a sub-admin may be given leave to do.
 *
 * An admin can do everything here. A member can be made a sub-admin by an
 * admin, who chooses which of an admin's powers they are to have: each is
 * one of the permissions below, and a sub-admin may hold any of them, in any
 * combination. A member who holds none is a member and nothing more.
 *
 * Some things stay with the admins whatever is given: making and unmaking
 * sub-admins, anything done to an admin or to another sub-admin, and naming
 * the main admin, whose writing is the canon.
 *
 * A member's permissions are kept in users.permissions, as their keys with
 * spaces between.
 */

/* each with the few words it goes by and what it lets its holder do, as the page that grants it says it */
export const PERMISSIONS = [
  {
    key: "write",
    name: "Start posts",
    says: "Start a new post in the journal. Without this a member can only answer one, with a commentary.",
  },
  {
    key: "edit",
    name: "Edit the journal",
    says: "See everyone’s drafts, and change, unpublish, restore or delete any post or commentary, the canon included.",
  },
  {
    key: "moderate",
    name: "Moderate",
    says: "Remove anyone’s margin note or reply, and any message in a room they can read.",
  },
  {
    key: "members",
    name: "Manage members",
    says: "Add members, issue them new passwords, and remove or restore them. Admins and other sub-admins are out of their reach.",
  },
  {
    key: "projects",
    name: "Oversee projects",
    says: "See every project, the private ones too, with its conversation, and do in each what its owner can.",
  },
];

const KEYS = PERMISSIONS.map((permission) => permission.key);

/**
 * The permissions named in a stored list, or by the boxes ticked in a form,
 * as their keys in the order above. Anything that is not one of them is
 * dropped, so nothing can be granted that is not known here.
 */
export function permissionKeys(value) {
  const named = new Set(Array.isArray(value) ? value.map(String) : String(value ?? "").split(/\s+/));
  return KEYS.filter((key) => named.has(key));
}

/** what a member holds, as the permissions themselves: for an admin, every one */
export const held = (user) => {
  const keys = user.role === "admin" ? KEYS : permissionKeys(user.permissions);
  return PERMISSIONS.filter((permission) => keys.includes(permission.key));
};

/** whether a member may do what a permission lets its holder do: an admin always may */
export function can(user, key) {
  // a permission misspelt where it is asked about would otherwise be refused to everyone but the admins, and go unnoticed
  if (!KEYS.includes(key)) throw new RangeError(`There is no permission called "${key}".`);
  return Boolean(user) && (user.role === "admin" || permissionKeys(user.permissions).includes(key));
}

/** a member who is not an admin but has been given some of what an admin may do */
export const isSubAdmin = (user) => user.role !== "admin" && permissionKeys(user.permissions).length > 0;

/** what someone is here, in a word: "Admin", "Sub-admin" or "Member" */
export const standing = (user) => (user.role === "admin" ? "Admin" : isSubAdmin(user) ? "Sub-admin" : "Member");
