/*
 * atspi-tool.c — fast AT-SPI CLI for desktop automation
 *
 * Build:
 *   gcc -O2 -o /opt/atspi-tool /Users/waqr/atspi-tool.c \
 *       $(pkg-config --cflags --libs atspi-2 gobject-2.0 dbus-1)
 */

#define _GNU_SOURCE  /* for strcasestr */
#include <atspi/atspi.h>
#include <dbus/dbus.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <ctype.h>

#define SNAP_FILE "/tmp/atspi-last-snap.json"
#define SNAP_FILE_APP_PREFIX "/tmp/atspi-last-snap-"
#define MAX_DEPTH 10
#define INTERACT_MAX_DEPTH 20
#define MAX_TEXT  500

/* ── growable string buffer ──────────────────────────────────────── */

typedef struct { char *data; size_t len, cap; } Buf;

static void buf_init(Buf *b) {
    b->cap = 4096; b->data = malloc(b->cap); b->data[0] = '\0'; b->len = 0;
}
static void buf_append(Buf *b, const char *s) {
    size_t sl = strlen(s);
    while (b->len + sl + 1 > b->cap) { b->cap *= 2; b->data = realloc(b->data, b->cap); }
    memcpy(b->data + b->len, s, sl + 1); b->len += sl;
}
static void buf_free(Buf *b) { free(b->data); b->data = NULL; }

/* ── fast D-Bus path for "apps" (no libatspi init) ───────────────── */

static int cmd_apps_fast(void) {
    DBusError err;
    dbus_error_init(&err);

    /* Connect to session bus */
    DBusConnection *session = dbus_bus_get(DBUS_BUS_SESSION, &err);
    if (!session) {
        if (dbus_error_is_set(&err)) dbus_error_free(&err);
        return 0;
    }

    /* Get AT-SPI bus address */
    DBusMessage *msg = dbus_message_new_method_call(
        "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress");
    DBusMessage *reply = dbus_connection_send_with_reply_and_block(session, msg, 1000, &err);
    dbus_message_unref(msg);
    if (!reply) {
        if (dbus_error_is_set(&err)) dbus_error_free(&err);
        return 0;
    }
    const char *addr;
    dbus_message_get_args(reply, NULL, DBUS_TYPE_STRING, &addr, DBUS_TYPE_INVALID);
    char *bus_addr = strdup(addr);
    dbus_message_unref(reply);

    /* Connect to AT-SPI bus */
    DBusConnection *conn = dbus_connection_open(bus_addr, &err);
    if (!conn) {
        if (dbus_error_is_set(&err)) dbus_error_free(&err);
        free(bus_addr); return 0;
    }
    if (!dbus_bus_register(conn, &err)) {
        if (dbus_error_is_set(&err)) dbus_error_free(&err);
        dbus_connection_unref(conn); free(bus_addr); return 0;
    }
    free(bus_addr);

    /* Get children of desktop root */
    msg = dbus_message_new_method_call(
        "org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root",
        "org.a11y.atspi.Accessible", "GetChildren");
    reply = dbus_connection_send_with_reply_and_block(conn, msg, 1000, &err);
    dbus_message_unref(msg);
    if (!reply) {
        if (dbus_error_is_set(&err)) dbus_error_free(&err);
        dbus_connection_unref(conn); return 0;
    }

    /* Parse array of (string, object_path) */
    DBusMessageIter iter, array, struc;
    dbus_message_iter_init(reply, &iter);
    dbus_message_iter_recurse(&iter, &array);

    typedef struct { char bus_name[64]; char path[128]; } Child;
    Child children[128];
    int n = 0;
    while (dbus_message_iter_get_arg_type(&array) != DBUS_TYPE_INVALID && n < 128) {
        dbus_message_iter_recurse(&array, &struc);
        const char *name, *path;
        dbus_message_iter_get_basic(&struc, &name);
        dbus_message_iter_next(&struc);
        dbus_message_iter_get_basic(&struc, &path);
        snprintf(children[n].bus_name, 64, "%s", name);
        snprintf(children[n].path, 128, "%s", path);
        n++;
        dbus_message_iter_next(&array);
    }
    dbus_message_unref(reply);

    /* Send all Name property requests in parallel (pipelined) */
    DBusPendingCall *pending[128];
    for (int i = 0; i < n; i++) {
        msg = dbus_message_new_method_call(
            children[i].bus_name, children[i].path,
            "org.freedesktop.DBus.Properties", "Get");
        const char *iface = "org.a11y.atspi.Accessible";
        const char *prop = "Name";
        dbus_message_append_args(msg,
            DBUS_TYPE_STRING, &iface, DBUS_TYPE_STRING, &prop, DBUS_TYPE_INVALID);
        dbus_connection_send_with_reply(conn, msg, &pending[i], 30);
        dbus_message_unref(msg);
    }
    dbus_connection_flush(conn);

    /* Collect replies */
    for (int i = 0; i < n; i++) {
        if (!pending[i]) continue;
        dbus_pending_call_block(pending[i]);
        reply = dbus_pending_call_steal_reply(pending[i]);
        dbus_pending_call_unref(pending[i]);
        if (!reply || dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_ERROR) {
            if (reply) dbus_message_unref(reply);
            continue;
        }
        DBusMessageIter ri, vi;
        dbus_message_iter_init(reply, &ri);
        dbus_message_iter_recurse(&ri, &vi);
        if (dbus_message_iter_get_arg_type(&vi) == DBUS_TYPE_STRING) {
            const char *app_name;
            dbus_message_iter_get_basic(&vi, &app_name);
            if (app_name && app_name[0]) printf("  %s\n", app_name);
        }
        dbus_message_unref(reply);
    }

    dbus_connection_unref(conn);
    return 1;
}

/* ── libatspi helpers ────────────────────────────────────────────── */

static const char *safe_str(const char *s) { return s ? s : ""; }

static char *clean_label(const char *input) {
    if (!input) return NULL;
    char *clean = malloc(strlen(input) + 1);
    char *w = clean;
    for (const char *p = input; *p; ) {
        unsigned char c = (unsigned char)*p;
        if (c == 0xEF && (unsigned char)p[1] == 0xBF && (unsigned char)p[2] == 0xBC)
            { p += 3; continue; }
        if (c == 0xE2 && (unsigned char)p[1] == 0x80 && (unsigned char)p[2] == 0xA2)
            { p += 3; continue; }
        if (c == 0xC2 && (unsigned char)p[1] == 0xA0)
            { *w++ = ' '; p += 2; continue; }
        *w++ = *p++;
    }
    *w = '\0';

    char *start = clean;
    while (*start && isspace((unsigned char)*start)) start++;
    char *end = clean + strlen(clean);
    while (end > start && isspace((unsigned char)end[-1])) end--;
    *end = '\0';

    char *out = strdup(start);
    free(clean);
    return out;
}

static char *decode_escapes(const char *input) {
    char *out = malloc(strlen(input) + 1);
    char *w = out;
    for (const char *p = input; *p; p++) {
        if (*p == '\\' && p[1]) {
            p++;
            if (*p == 'n') *w++ = '\n';
            else if (*p == 't') *w++ = '\t';
            else if (*p == 'r') *w++ = '\r';
            else *w++ = *p;
        } else {
            *w++ = *p;
        }
    }
    *w = '\0';
    return out;
}

static int is_showing(AtspiAccessible *node) {
    AtspiStateSet *states = atspi_accessible_get_state_set(node);
    if (!states) return 1;
    int showing = atspi_state_set_contains(states, ATSPI_STATE_SHOWING);
    g_object_unref(states);
    return showing;
}

static int has_state(AtspiAccessible *node, AtspiStateType state) {
    AtspiStateSet *states = atspi_accessible_get_state_set(node);
    if (!states) return 0;
    int has = atspi_state_set_contains(states, state);
    g_object_unref(states);
    return has;
}

static int is_editable_text(AtspiAccessible *node) {
    if (has_state(node, ATSPI_STATE_EDITABLE)) return 1;
    AtspiEditableText *editable = atspi_accessible_get_editable_text_iface(node);
    if (!editable) return 0;
    g_object_unref(editable);
    return 1;
}

static char *get_role(AtspiAccessible *node) {
    GError *err = NULL;
    char *role = atspi_accessible_get_role_name(node, &err);
    if (err) { g_error_free(err); return g_strdup("unknown"); }
    return role ? role : g_strdup("unknown");
}

static char *get_name(AtspiAccessible *node) {
    GError *err = NULL;
    char *name = atspi_accessible_get_name(node, &err);
    if (err) { g_error_free(err); return NULL; }
    return name;
}

static int get_child_count(AtspiAccessible *node) {
    GError *err = NULL;
    int n = atspi_accessible_get_child_count(node, &err);
    if (err) { g_error_free(err); return 0; }
    return n;
}

static AtspiAccessible *get_child(AtspiAccessible *node, int i) {
    GError *err = NULL;
    AtspiAccessible *c = atspi_accessible_get_child_at_index(node, i, &err);
    if (err) { g_error_free(err); return NULL; }
    return c;
}

static void atspi_lazy_init(void) {
    static int done = 0;
    if (!done) {
        atspi_set_timeout(1000, 15);
        atspi_init();
        done = 1;
    }
}

/* ── tree walk ───────────────────────────────────────────────────── */

static const char *skip_unnamed[] = {
    "separator", "filler", "unknown", "redundant object",
    "animation", "panel", "scroll pane", "viewport", "scroll bar",
    "page", "section", "article", "list", "list item",
    "document text", "document frame", "embedded",
    "footer", "header", "form", "math fraction",
    "table", "input method window",
    NULL
};

static int is_skip_unnamed(const char *role) {
    for (int i = 0; skip_unnamed[i]; i++)
        if (strcmp(role, skip_unnamed[i]) == 0) return 1;
    return 0;
}

static int is_skip_nonshowing_role(const char *role) {
    static const char *roles[] = {
        "menu item", "menu", "push button", "toggle button", "radio button",
        "check box", "combo box", NULL
    };
    for (int i = 0; roles[i]; i++)
        if (strcmp(role, roles[i]) == 0) return 1;
    return 0;
}

static void indent_buf(Buf *b, int depth) {
    for (int i = 0; i < depth; i++) buf_append(b, "  ");
}

static void tree_walk(AtspiAccessible *node, int depth, int max_depth,
                      int filtered, Buf *buf)
{
    if (!node || depth > max_depth) return;

    char *role = get_role(node);
    char *raw_name = get_name(node);
    char *name = clean_label(raw_name);
    const char *sname = safe_str(name);
    int named = name && name[0];

    if (filtered && depth > 0 && !is_showing(node) && is_skip_nonshowing_role(role)) {
        g_free(role); g_free(raw_name); free(name);
        return;
    }

    int nchildren = get_child_count(node);

    if (filtered && !named && is_skip_unnamed(role)) {
        g_free(role); g_free(raw_name); free(name);
        for (int i = 0; i < nchildren; i++) {
            AtspiAccessible *child = get_child(node, i);
            if (child) { tree_walk(child, depth, max_depth, filtered, buf); g_object_unref(child); }
        }
        return;
    }

    int has_action = 0;
    AtspiAction *action = atspi_accessible_get_action_iface(node);
    if (action) {
        GError *err = NULL;
        int na = atspi_action_get_n_actions(action, &err);
        if (!err && na > 0) has_action = 1;
        if (err) g_error_free(err);
        g_object_unref(action);
    }
    int editable = is_editable_text(node);

    char *text_value = NULL;
    AtspiText *text_iface = atspi_accessible_get_text_iface(node);
    if (text_iface) {
        GError *err = NULL;
        int ccount = atspi_text_get_character_count(text_iface, &err);
        if (!err && ccount > 0) {
            int end = ccount < MAX_TEXT ? ccount : MAX_TEXT;
            GError *err2 = NULL;
            text_value = atspi_text_get_text(text_iface, 0, end, &err2);
            if (err2) { g_error_free(err2); text_value = NULL; }
        }
        if (err) g_error_free(err);
        g_object_unref(text_iface);
    }

    /* strip U+FFFC (object replacement) and U+2022 (bullet) from text, then discard if empty */
    if (filtered && text_value) {
        char *clean = clean_label(text_value);
        g_free(text_value);
        text_value = clean && clean[0] ? g_strdup(clean) : NULL;
        free(clean);
    }

    indent_buf(buf, depth);
    buf_append(buf, "["); buf_append(buf, role); buf_append(buf, "]");
    if (named) {
        buf_append(buf, " \"");
        if (filtered && strlen(sname) > 80) {
            char trunc[84];
            memcpy(trunc, sname, 77); trunc[77] = '.'; trunc[78] = '.'; trunc[79] = '.'; trunc[80] = '\0';
            buf_append(buf, trunc);
        } else {
            buf_append(buf, sname);
        }
        buf_append(buf, "\"");
    }
    if (has_action) buf_append(buf, " (clickable)");
    if (editable) buf_append(buf, " (editable)");
    if (text_value && text_value[0] && (!named || strcmp(text_value, sname) != 0)) {
        buf_append(buf, " text=\"");
        if (filtered && strlen(text_value) > 120) {
            char trunc[124];
            memcpy(trunc, text_value, 117);
            trunc[117] = '.'; trunc[118] = '.'; trunc[119] = '.'; trunc[120] = '\0';
            buf_append(buf, trunc);
        } else {
            buf_append(buf, text_value);
        }
        buf_append(buf, "\"");
    }
    buf_append(buf, "\n");

    g_free(role); g_free(raw_name); free(name); g_free(text_value);

    for (int i = 0; i < nchildren; i++) {
        AtspiAccessible *child = get_child(node, i);
        if (child) { tree_walk(child, depth + 1, max_depth, filtered, buf); g_object_unref(child); }
    }
}

/* forward declarations */
static AtspiAccessible *find_app(AtspiAccessible *desktop, const char *app_name);

/* ── interact walk (flat list of actionable elements) ──────────── */

typedef struct { char *role; char *name; } InteractItem;
typedef struct { InteractItem *items; int count, cap; } InteractList;

static int is_substring_of_existing(InteractList *il, const char *name) {
    for (int i = 0; i < il->count; i++) {
        if (strcmp(il->items[i].name, name) == 0) return 1;
        if (strstr(il->items[i].name, name)) return 1;
        if (strstr(name, il->items[i].name)) return 1;
    }
    return 0;
}

static void interact_add(InteractList *il, const char *role, const char *name) {
    /* global dedup: skip if name (or its core) already seen */
    if (is_substring_of_existing(il, name)) return;
    if (il->count >= il->cap) {
        il->cap = il->cap ? il->cap * 2 : 64;
        il->items = realloc(il->items, il->cap * sizeof(InteractItem));
    }
    il->items[il->count].role = strdup(role);
    /* truncate name at 100 chars for display */
    if (strlen(name) > 100) {
        char *t = malloc(104);
        memcpy(t, name, 97); t[97] = '.'; t[98] = '.'; t[99] = '.'; t[100] = '\0';
        il->items[il->count].name = t;
    } else {
        il->items[il->count].name = strdup(name);
    }
    il->count++;
}

static void interact_walk(AtspiAccessible *node, int depth, InteractList *il) {
    if (!node || depth > INTERACT_MAX_DEPTH) return;

    char *role = get_role(node);
    char *raw_name = get_name(node);
    char *name = clean_label(raw_name);
    int named = name && name[0];

    if (depth > 0 && !is_showing(node) && is_skip_nonshowing_role(role)) {
        g_free(role); g_free(raw_name); free(name);
        return;
    }

    /* skip roles that are purely structural / metadata in web content */
    static const char *skip_roles[] = {
        "math fraction", "definition", "unknown", "list item",
        "document text", "document frame", "embedded", "audio", "image",
        NULL
    };
    int skip_role = 0;
    for (int s = 0; skip_roles[s]; s++)
        if (strcmp(role, skip_roles[s]) == 0) { skip_role = 1; break; }

    /* check for action interface */
    int has_action = 0;
    AtspiAction *action = atspi_accessible_get_action_iface(node);
    if (action) {
        GError *err = NULL;
        int na = atspi_action_get_n_actions(action, &err);
        if (!err && na > 0) has_action = 1;
        if (err) g_error_free(err);
        g_object_unref(action);
    }

    int editable = is_editable_text(node);

    if (!skip_role || editable) {
        const char *label = named ? name : (editable ? role : NULL);

        if ((has_action || editable) && label && label[0]) {
            /* skip "Advertisement:" prefixed (ad noise in web content) */
            int junk = strncmp(label, "Advertisement:", 14) == 0;
            if (!junk) interact_add(il, role, label);
        }
    }

    g_free(role); g_free(raw_name); free(name);

    int nchildren = get_child_count(node);
    for (int i = 0; i < nchildren; i++) {
        AtspiAccessible *child = get_child(node, i);
        if (child) { interact_walk(child, depth + 1, il); g_object_unref(child); }
    }
}

static void cmd_interact(const char *app_name) {
    atspi_lazy_init();
    AtspiAccessible *desktop = atspi_get_desktop(0);

    if (!app_name) {
        fprintf(stderr, "Usage: atspi interact <app>\n");
        g_object_unref(desktop); exit(1);
    }

    AtspiAccessible *app = find_app(desktop, app_name);
    if (!app) {
        fprintf(stderr, "Error: app '%s' not found\n", app_name);
        g_object_unref(desktop); exit(1);
    }

    InteractList il = {0};
    interact_walk(app, 0, &il);

    /* mark printed items */
    char *done = calloc(il.count, 1);

    /* group by role — known roles first */
    static const char *role_order[] = {
        "push button", "toggle button", "radio button", "check box",
        "link", "combo box", "menu item", "text", "entry",
        NULL
    };

    for (int r = 0; role_order[r]; r++) {
        int first = 1;
        for (int i = 0; i < il.count; i++) {
            if (done[i]) continue;
            if (strcmp(il.items[i].role, role_order[r]) == 0) {
                if (first) { printf("[%s]\n", role_order[r]); first = 0; }
                printf("  %s\n", il.items[i].name);
                done[i] = 1;
            }
        }
    }
    /* then any remaining roles */
    for (int i = 0; i < il.count; i++) {
        if (done[i]) continue;
        int first = 1;
        const char *r = il.items[i].role;
        for (int j = i; j < il.count; j++) {
            if (done[j]) continue;
            if (strcmp(il.items[j].role, r) == 0) {
                if (first) { printf("[%s]\n", r); first = 0; }
                printf("  %s\n", il.items[j].name);
                done[j] = 1;
            }
        }
    }
    free(done);

    if (il.count == 0) printf("No interactive elements found.\n");
    else printf("\n(%d elements)\n", il.count);

    for (int i = 0; i < il.count; i++) { free(il.items[i].role); free(il.items[i].name); }
    free(il.items);
    g_object_unref(app); g_object_unref(desktop);
}

/* ── find app / node ─────────────────────────────────────────────── */

static AtspiAccessible *find_app(AtspiAccessible *desktop, const char *app_name) {
    int n = get_child_count(desktop);
    for (int i = n - 1; i >= 0; i--) {
        AtspiAccessible *app = get_child(desktop, i);
        if (!app) continue;
        char *name = get_name(app);
        if (name && strcasecmp(name, app_name) == 0) { g_free(name); return app; }
        g_free(name); g_object_unref(app);
    }
    for (int i = n - 1; i >= 0; i--) {
        AtspiAccessible *app = get_child(desktop, i);
        if (!app) continue;
        char *name = get_name(app);
        if (name && strcasestr(name, app_name)) { g_free(name); return app; }
        g_free(name); g_object_unref(app);
    }
    return NULL;
}

static AtspiAccessible *find_node(AtspiAccessible *parent, const char *target,
                                  const char *target_role)
{
    if (!parent) return NULL;
    char *raw_name = get_name(parent);
    char *name = clean_label(raw_name);
    char *role = get_role(parent);
    int named_match = name && strcmp(name, target) == 0;
    int role_match = (!name || !name[0]) && strcmp(role, target) == 0;
    if ((named_match || role_match) && (!target_role || strcmp(role, target_role) == 0)) {
        g_free(raw_name); free(name); g_free(role); return parent;
    }
    g_free(raw_name); free(name); g_free(role);
    int n = get_child_count(parent);
    for (int i = 0; i < n; i++) {
        AtspiAccessible *child = get_child(parent, i);
        if (!child) continue;
        AtspiAccessible *found = find_node(child, target, target_role);
        if (found) { if (found != child) g_object_unref(child); return found; }
        g_object_unref(child);
    }
    return NULL;
}

static AtspiAccessible *find_editable_node(AtspiAccessible *parent, int require_focused)
{
    if (!parent) return NULL;
    if (is_showing(parent) && is_editable_text(parent) &&
        (!require_focused || has_state(parent, ATSPI_STATE_FOCUSED))) {
        return parent;
    }
    int n = get_child_count(parent);
    for (int i = 0; i < n; i++) {
        AtspiAccessible *child = get_child(parent, i);
        if (!child) continue;
        AtspiAccessible *found = find_editable_node(child, require_focused);
        if (found) { if (found != child) g_object_unref(child); return found; }
        g_object_unref(child);
    }
    return NULL;
}

/* ── commands ────────────────────────────────────────────────────── */

static void cmd_apps_atspi(void) {
    AtspiAccessible *desktop = atspi_get_desktop(0);
    int n = get_child_count(desktop);
    for (int i = 0; i < n; i++) {
        AtspiAccessible *app = get_child(desktop, i);
        if (!app) continue;
        char *name = get_name(app);
        if (name && name[0]) printf("  %s\n", name);
        g_free(name); g_object_unref(app);
    }
    g_object_unref(desktop);
}

static void cmd_read(const char *app_name, int raw) {
    atspi_lazy_init();
    AtspiAccessible *desktop = atspi_get_desktop(0);
    int filtered = !raw;

    if (app_name) {
        AtspiAccessible *app = find_app(desktop, app_name);
        if (!app) {
            fprintf(stderr, "Error: app '%s' not found. Available:\n", app_name);
            cmd_apps_atspi();
            g_object_unref(desktop); exit(1);
        }
        Buf buf; buf_init(&buf);
        tree_walk(app, 0, MAX_DEPTH, filtered, &buf);
        printf("%s", buf.data);
        buf_free(&buf); g_object_unref(app);
    } else {
        int n = get_child_count(desktop);
        for (int i = 0; i < n; i++) {
            AtspiAccessible *app = get_child(desktop, i);
            if (!app) continue;
            char *name = get_name(app);
            if (name && name[0]) {
                Buf buf; buf_init(&buf);
                tree_walk(app, 0, MAX_DEPTH, filtered, &buf);
                if (buf.len > 0) {
                    int has = 0;
                    for (size_t j = 0; j < buf.len; j++)
                        if (buf.data[j] != ' ' && buf.data[j] != '\n' &&
                            buf.data[j] != '\t' && buf.data[j] != '\r') { has = 1; break; }
                    if (has) printf("%s", buf.data);
                }
                buf_free(&buf);
            }
            g_free(name); g_object_unref(app);
        }
    }
    g_object_unref(desktop);
}

static void cmd_find(const char *app_name, const char *pattern) {
    atspi_lazy_init();
    AtspiAccessible *desktop = atspi_get_desktop(0);

    if (!app_name || !pattern || !pattern[0]) {
        fprintf(stderr, "Usage: atspi find <app> <pattern>\n");
        g_object_unref(desktop); exit(1);
    }

    AtspiAccessible *app = find_app(desktop, app_name);
    if (!app) {
        fprintf(stderr, "Error: app '%s' not found\n", app_name);
        g_object_unref(desktop); exit(1);
    }

    Buf buf; buf_init(&buf);
    tree_walk(app, 0, MAX_DEPTH, 1, &buf);

    int matches = 0;
    int shown = 0;
    const int max_shown = 60;
    const char *p = buf.data;
    while (*p) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        if (len > 0) {
            char *line = malloc(len + 1);
            memcpy(line, p, len); line[len] = '\0';
            if (strcasestr(line, pattern)) {
                matches++;
                if (shown < max_shown) {
                    if (strlen(line) > 240) {
                        line[237] = '.'; line[238] = '.'; line[239] = '.'; line[240] = '\0';
                    }
                    printf("%s\n", line);
                    shown++;
                }
            }
            free(line);
        }
        if (!nl) break;
        p = nl + 1;
    }

    if (matches == 0) printf("No matches for '%s' in '%s'.\n", pattern, app_name);
    else if (matches > shown) printf("... %d more matches not shown\n", matches - shown);
    printf("(%d matches)\n", matches);

    buf_free(&buf);
    g_object_unref(app); g_object_unref(desktop);
}

static void cmd_click(const char *app_name, const char *element_name) {
    atspi_lazy_init();
    AtspiAccessible *desktop = atspi_get_desktop(0);
    AtspiAccessible *app = find_app(desktop, app_name);
    if (!app) {
        fprintf(stderr, "Error: app '%s' not found\n", app_name);
        g_object_unref(desktop); exit(1);
    }
    static const char *try_roles[] = {
        "push button", "toggle button", "radio button", "menu item",
        "check box", "link", "combo box", NULL
    };
    AtspiAccessible *node = NULL;
    for (int r = 0; try_roles[r]; r++) {
        node = find_node(app, element_name, try_roles[r]);
        if (node) break;
    }
    if (!node) node = find_node(app, element_name, NULL);
    if (!node) {
        fprintf(stderr, "Error: element '%s' not found in '%s'\n", element_name, app_name);
        g_object_unref(app); g_object_unref(desktop); exit(1);
    }
    AtspiAction *action = atspi_accessible_get_action_iface(node);
    if (!action) {
        AtspiComponent *component = atspi_accessible_get_component_iface(node);
        if (component) {
            GError *err = NULL;
            atspi_component_grab_focus(component, &err);
            if (err) {
                g_error_free(err);
                err = NULL;
            }

            AtspiRect *rect = atspi_component_get_extents(component, ATSPI_COORD_TYPE_SCREEN, &err);
            if (!err && rect && rect->width > 0 && rect->height > 0) {
                int x = rect->x + rect->width / 2;
                int y = rect->y + rect->height / 2;
                char click_cmd[256];
                snprintf(click_cmd, sizeof(click_cmd),
                         "xdotool mousemove --sync %d %d click 1 >/dev/null 2>&1", x, y);
                int ret = system(click_cmd);
                g_free(rect);
                if (ret == 0) {
                    printf("Clicked '%s' in '%s'\n", element_name, app_name);
                    g_object_unref(component);
                    g_object_unref(node); g_object_unref(app); g_object_unref(desktop); return;
                }
            } else {
                if (err) { g_error_free(err); err = NULL; }
                if (rect) g_free(rect);
            }

            err = NULL;
            atspi_component_grab_focus(component, &err);
            if (!err) {
                printf("Focused '%s' in '%s'\n", element_name, app_name);
                g_object_unref(component);
                g_object_unref(node); g_object_unref(app); g_object_unref(desktop); return;
            }
            g_error_free(err);
            g_object_unref(component);
        }
        fprintf(stderr, "Error: element '%s' has no action or focus interface\n", element_name);
        g_object_unref(node); g_object_unref(app); g_object_unref(desktop); exit(1);
    }
    GError *err = NULL;
    atspi_action_do_action(action, 0, &err);
    if (err) {
        fprintf(stderr, "Error: %s\n", err->message);
        g_error_free(err); g_object_unref(action);
        g_object_unref(node); g_object_unref(app); g_object_unref(desktop); exit(1);
    }
    printf("Clicked '%s' in '%s'\n", element_name, app_name);
    g_object_unref(action); g_object_unref(node);
    g_object_unref(app); g_object_unref(desktop);
}

static char *shell_quote(const char *s) {
    size_t len = 3;
    for (const char *p = s; *p; p++) len += (*p == '\'') ? 4 : 1;
    char *out = malloc(len);
    if (!out) { perror("malloc"); exit(1); }
    char *q = out;
    *q++ = '\'';
    for (const char *p = s; *p; p++) {
        if (*p == '\'') {
            memcpy(q, "'\\''", 4);
            q += 4;
        } else {
            *q++ = *p;
        }
    }
    *q++ = '\'';
    *q = '\0';
    return out;
}

static void cmd_focus(const char *app_name) {
    char cmd[4096];
    char *q = shell_quote(app_name);
    snprintf(cmd, sizeof(cmd),
        "WID=$({ xdotool search --name %s 2>/dev/null; "
        "xdotool search --class %s 2>/dev/null; } | tail -1) && "
        "[ -n \"$WID\" ] && xdotool windowactivate \"$WID\"",
        q, q);
    int ret = system(cmd);
    free(q);
    if (ret == 0) {
        printf("Focused: %s\n", app_name);
        exit(0);
    }
    fprintf(stderr, "Error: no window found for '%s'\n", app_name);
    exit(1);
}

static void cmd_open(const char *command) {
    if (fork() == 0) { setsid(); execl("/bin/sh", "sh", "-c", command, NULL); _exit(1); }
    sleep(2);
    printf("Launched: %s\n", command);
}

static void cmd_close(const char *app_name) {
    char cmd[4096];
    char *q = shell_quote(app_name);
    snprintf(cmd, sizeof(cmd),
        "WID=$({ xdotool search --name %s 2>/dev/null; "
        "xdotool search --class %s 2>/dev/null; } | tail -1) && "
        "[ -n \"$WID\" ] && xdotool windowactivate \"$WID\" && sleep 0.2 && "
        "xdotool windowclose \"$WID\"",
        q, q);
    int ret = system(cmd);
    free(q);
    if (ret == 0) {
        printf("Closed: %s\n", app_name);
    } else {
        fprintf(stderr, "Error: no window found for '%s'\n", app_name);
        exit(1);
    }
}

static void cmd_insert(const char *app_name, const char *maybe_target, const char *text) {
    atspi_lazy_init();
    AtspiAccessible *desktop = atspi_get_desktop(0);
    AtspiAccessible *app = find_app(desktop, app_name);
    if (!app) {
        fprintf(stderr, "Error: app '%s' not found\n", app_name);
        g_object_unref(desktop); exit(1);
    }

    AtspiAccessible *node = NULL;
    char *combined_text = NULL;
    const char *insert_text = text;

    if (maybe_target) {
        node = find_node(app, maybe_target, NULL);
        if (node && !is_editable_text(node)) {
            g_object_unref(node);
            node = NULL;
        }
        if (!node) {
            size_t len = strlen(maybe_target) + 1 + strlen(text) + 1;
            combined_text = malloc(len);
            snprintf(combined_text, len, "%s %s", maybe_target, text);
            insert_text = combined_text;
        }
    }

    AtspiAccessible *fallback_node = NULL;
    int used_focused = node ? has_state(node, ATSPI_STATE_FOCUSED) : 1;
    if (!node) {
        fallback_node = find_editable_node(app, 1);
        node = fallback_node;
        used_focused = 1;
    }
    if (!node) {
        fallback_node = find_editable_node(app, 0);
        node = fallback_node;
        used_focused = 0;
    }
    if (!node) {
        fprintf(stderr, "Error: no editable text field found in '%s'\n", app_name);
        free(combined_text);
        g_object_unref(app); g_object_unref(desktop); exit(1);
    }

    int pos = -1;
    AtspiText *text_iface = atspi_accessible_get_text_iface(node);
    if (text_iface) {
        GError *err = NULL;
        if (used_focused) pos = atspi_text_get_caret_offset(text_iface, &err);
        if (err) { g_error_free(err); err = NULL; pos = -1; }
        if (pos < 0) pos = atspi_text_get_character_count(text_iface, &err);
        if (err) { g_error_free(err); err = NULL; pos = -1; }
        g_object_unref(text_iface);
    }
    if (pos < 0) pos = 0;

    AtspiEditableText *editable = atspi_accessible_get_editable_text_iface(node);
    if (!editable) {
        fprintf(stderr, "Error: editable text interface disappeared in '%s'\n", app_name);
        g_object_unref(node); g_object_unref(app); g_object_unref(desktop); exit(1);
    }

    GError *err = NULL;
    char *decoded = decode_escapes(insert_text);
    gboolean ok = atspi_editable_text_insert_text(editable, pos, decoded, strlen(decoded), &err);
    if (err || !ok) {
        fprintf(stderr, "Error: %s\n", err ? err->message : "insert_text failed");
        if (err) g_error_free(err);
        free(decoded); free(combined_text);
        g_object_unref(editable); g_object_unref(node);
        g_object_unref(app); g_object_unref(desktop); exit(1);
    }
    printf("Inserted %zu bytes into '%s' at offset %d\n", strlen(decoded), app_name, pos);
    free(decoded); free(combined_text);
    g_object_unref(editable); g_object_unref(node);
    g_object_unref(app); g_object_unref(desktop);
}

/* ── snap helpers ────────────────────────────────────────────────── */

static void json_escape(const char *s, Buf *out) {
    for (; *s; s++) {
        switch (*s) {
            case '"':  buf_append(out, "\\\""); break;
            case '\\': buf_append(out, "\\\\"); break;
            case '\n': buf_append(out, "\\n");  break;
            case '\r': buf_append(out, "\\r");  break;
            case '\t': buf_append(out, "\\t");  break;
            default: { char c[2] = { *s, '\0' }; buf_append(out, c); }
        }
    }
}

static char *read_file(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    char *data = malloc(sz + 1);
    if (fread(data, 1, sz, f) != (size_t)sz) { free(data); fclose(f); return NULL; }
    data[sz] = '\0'; fclose(f); return data;
}

static char *json_extract_value(const char *json, const char *key) {
    char search[512];
    snprintf(search, sizeof(search), "\"%s\"", key);
    const char *p = strstr(json, search);
    if (!p) return NULL;
    p += strlen(search);
    while (*p == ' ' || *p == ':') p++;
    if (*p != '"') return NULL;
    p++;
    Buf val; buf_init(&val);
    while (*p && !(*p == '"' && *(p-1) != '\\')) {
        if (*p == '\\' && *(p+1)) {
            p++;
            switch (*p) {
                case 'n':  buf_append(&val, "\n"); break;
                case 'r':  buf_append(&val, "\r"); break;
                case 't':  buf_append(&val, "\t"); break;
                case '"':  buf_append(&val, "\""); break;
                case '\\': buf_append(&val, "\\"); break;
                default: { char c[3] = {'\\', *p, '\0'}; buf_append(&val, c); } break;
            }
        } else { char c[2] = { *p, '\0' }; buf_append(&val, c); }
        p++;
    }
    return val.data;
}

typedef struct { char **items; int count, cap; } StrList;

static void strlist_add_unique(StrList *sl, const char *s) {
    for (int i = 0; i < sl->count; i++) if (strcmp(sl->items[i], s) == 0) return;
    if (sl->count >= sl->cap) {
        sl->cap = sl->cap ? sl->cap * 2 : 16;
        sl->items = realloc(sl->items, sl->cap * sizeof(char*));
    }
    sl->items[sl->count++] = strdup(s);
}
static void strlist_add(StrList *sl, const char *s) {
    if (sl->count >= sl->cap) {
        sl->cap = sl->cap ? sl->cap * 2 : 64;
        sl->items = realloc(sl->items, sl->cap * sizeof(char*));
    }
    sl->items[sl->count++] = strdup(s);
}
static void strlist_free(StrList *sl) {
    for (int i = 0; i < sl->count; i++) free(sl->items[i]);
    free(sl->items);
}
static int strlist_contains(StrList *sl, const char *s) {
    for (int i = 0; i < sl->count; i++) if (strcmp(sl->items[i], s) == 0) return 1;
    return 0;
}
static int strcmp_ptr(const void *a, const void *b) {
    return strcmp(*(const char**)a, *(const char**)b);
}

static void json_get_keys(const char *json, StrList *kl) {
    if (!json) return;
    const char *p = json;
    while ((p = strchr(p, '"')) != NULL) {
        p++;
        const char *end = strchr(p, '"');
        if (!end) break;
        const char *q = end + 1;
        while (*q == ' ') q++;
        if (*q == ':') {
            int len = end - p;
            char *key = malloc(len + 1);
            memcpy(key, p, len); key[len] = '\0';
            strlist_add_unique(kl, key);
            free(key);
        }
        p = end + 1;
    }
}

static void split_lines(const char *text, StrList *ls) {
    if (!text) return;
    const char *p = text;
    while (*p) {
        const char *nl = strchr(p, '\n');
        int len = nl ? (int)(nl - p) : (int)strlen(p);
        if (len > 0) {
            char *line = malloc(len + 1);
            memcpy(line, p, len); line[len] = '\0';
            int ws = 1;
            for (int i = 0; i < len; i++)
                if (line[i] != ' ' && line[i] != '\t') { ws = 0; break; }
            if (!ws) strlist_add(ls, line);
            free(line);
        }
        if (!nl) break;
        p = nl + 1;
    }
}

static char *snap_file_for(const char *app_name) {
    if (!app_name || !app_name[0]) return strdup(SNAP_FILE);

    char safe[128];
    int j = 0;
    for (const char *p = app_name; *p && j < (int)sizeof(safe) - 1; p++) {
        unsigned char c = (unsigned char)*p;
        safe[j++] = isalnum(c) ? (char)tolower(c) : '-';
    }
    safe[j] = '\0';

    char *path = malloc(strlen(SNAP_FILE_APP_PREFIX) + strlen(safe) + 6);
    sprintf(path, "%s%s.json", SNAP_FILE_APP_PREFIX, safe);
    return path;
}

static void cmd_snap(const char *only_app) {
    atspi_lazy_init();
    AtspiAccessible *desktop = atspi_get_desktop(0);
    int n = get_child_count(desktop);

    char **app_names = NULL, **app_trees = NULL;
    int app_count = 0;

    if (only_app) {
        AtspiAccessible *app = find_app(desktop, only_app);
        if (!app) {
            fprintf(stderr, "Error: app '%s' not found\n", only_app);
            g_object_unref(desktop); exit(1);
        }
        char *name = get_name(app);
        if (name && name[0]) {
            Buf buf; buf_init(&buf);
            tree_walk(app, 0, MAX_DEPTH, 1, &buf);
            app_names = realloc(app_names, (app_count + 1) * sizeof(char*));
            app_trees = realloc(app_trees, (app_count + 1) * sizeof(char*));
            app_names[app_count] = strdup(name);
            app_trees[app_count] = buf.data;
            app_count++;
        }
        g_free(name); g_object_unref(app);
    } else {
        for (int i = 0; i < n; i++) {
            AtspiAccessible *app = get_child(desktop, i);
            if (!app) continue;
            char *name = get_name(app);
            if (name && name[0]) {
                Buf buf; buf_init(&buf);
                tree_walk(app, 0, MAX_DEPTH, 1, &buf);
                app_names = realloc(app_names, (app_count + 1) * sizeof(char*));
                app_trees = realloc(app_trees, (app_count + 1) * sizeof(char*));
                app_names[app_count] = strdup(name);
                app_trees[app_count] = buf.data;
                app_count++;
            }
            g_free(name); g_object_unref(app);
        }
    }

    char *snap_file = snap_file_for(only_app);
    char *prev_json = read_file(snap_file);

    FILE *f = fopen(snap_file, "w");
    if (f) {
        fprintf(f, "{");
        for (int i = 0; i < app_count; i++) {
            if (i > 0) fprintf(f, ", ");
            Buf ek; buf_init(&ek); json_escape(app_names[i], &ek);
            Buf ev; buf_init(&ev); json_escape(app_trees[i], &ev);
            fprintf(f, "\"%s\": \"%s\"", ek.data, ev.data);
            buf_free(&ek); buf_free(&ev);
        }
        fprintf(f, "}"); fclose(f);
    }

    StrList all_keys = {0};
    for (int i = 0; i < app_count; i++) strlist_add_unique(&all_keys, app_names[i]);
    if (prev_json && !only_app) json_get_keys(prev_json, &all_keys);
    qsort(all_keys.items, all_keys.count, sizeof(char*), strcmp_ptr);

    int has_diff = 0;
    for (int k = 0; k < all_keys.count; k++) {
        const char *aname = all_keys.items[k];
        const char *cur_tree = NULL;
        for (int i = 0; i < app_count; i++)
            if (strcmp(app_names[i], aname) == 0) { cur_tree = app_trees[i]; break; }
        char *prev_tree = prev_json ? json_extract_value(prev_json, aname) : NULL;
        const char *old_s = prev_tree ? prev_tree : "";
        const char *new_s = cur_tree ? cur_tree : "";
        if (strcmp(old_s, new_s) == 0) { free(prev_tree); continue; }

        has_diff = 1;
        printf("=== %s ===\n", aname);
        StrList old_ls = {0}, new_ls = {0};
        split_lines(old_s, &old_ls);
        split_lines(new_s, &new_ls);
        if (old_ls.count > 0) qsort(old_ls.items, old_ls.count, sizeof(char*), strcmp_ptr);
        if (new_ls.count > 0) qsort(new_ls.items, new_ls.count, sizeof(char*), strcmp_ptr);
        for (int i = 0; i < old_ls.count; i++)
            if (!strlist_contains(&new_ls, old_ls.items[i]))
                printf("- %s\n", old_ls.items[i]);
        for (int i = 0; i < new_ls.count; i++)
            if (!strlist_contains(&old_ls, new_ls.items[i]))
                printf("+ %s\n", new_ls.items[i]);
        printf("\n");
        strlist_free(&old_ls); strlist_free(&new_ls); free(prev_tree);
    }
    if (!has_diff) printf("No changes since last snapshot.\n");

    for (int i = 0; i < app_count; i++) { free(app_names[i]); free(app_trees[i]); }
    free(app_names); free(app_trees); free(prev_json); free(snap_file);
    strlist_free(&all_keys); g_object_unref(desktop);
}

/* ── usage / arg helpers ─────────────────────────────────────────── */

static void usage(void) {
    fprintf(stderr,
        "Usage:\n"
        "  atspi apps                  - list running applications\n"
        "  atspi read [app_name]       - show accessibility tree (filtered)\n"
        "  atspi read-raw [app_name]   - show full accessibility tree\n"
        "  atspi find <app> <pattern>  - show matching filtered tree lines\n"
        "  atspi interact <app>        - list interactive elements only\n"
        "  atspi click <app> <name>    - click element by name\n"
        "  atspi type <text>           - type text into focused element\n"
        "  atspi insert <app> [field] <text> - insert text into editable field (\\n supported)\n"
        "  atspi key <keys>            - send key combo\n"
        "  atspi snap [app_name]       - snapshot + diff, optionally scoped to one app\n"
        "  atspi focus <app>           - raise and focus window\n"
        "  atspi open <command>        - launch application\n"
        "  atspi close <app>           - close window\n"
    );
}

static char *join_args(int argc, char **argv, int from) {
    size_t len = 0;
    for (int i = from; i < argc; i++) len += strlen(argv[i]) + 1;
    char *buf = malloc(len + 1); buf[0] = '\0';
    for (int i = from; i < argc; i++) {
        if (i > from) strcat(buf, " ");
        strcat(buf, argv[i]);
    }
    return buf;
}

/* ── main ────────────────────────────────────────────────────────── */

int main(int argc, char **argv) {
    if (argc < 2) { usage(); return 0; }
    const char *cmd = argv[1];

    /* commands that don't need atspi at all */
    if (strcmp(cmd, "type") == 0) {
        if (argc < 3) { fprintf(stderr, "Usage: atspi type <text>\n"); return 1; }
        char *text = join_args(argc, argv, 2);
        printf("Typed: %s\n", text); fflush(stdout);
        execlp("xdotool", "xdotool", "type", "--clearmodifiers", "--", text, NULL);
        perror("xdotool"); return 1;
    }
    if (strcmp(cmd, "key") == 0) {
        if (argc != 3) { fprintf(stderr, "Usage: atspi key <keys>  (do not include an app name; use 'atspi focus <app>' first if needed)\n"); return 1; }
        printf("Sent key: %s\n", argv[2]); fflush(stdout);
        execlp("xdotool", "xdotool", "key", "--clearmodifiers", argv[2], NULL);
        perror("xdotool"); return 1;
    }
    if (strcmp(cmd, "insert") == 0) {
        if (argc < 4) { fprintf(stderr, "Usage: atspi insert <app> <text>\n"); return 1; }
        const char *maybe_target = argc >= 5 ? argv[3] : NULL;
        char *text = join_args(argc, argv, argc >= 5 ? 4 : 3);
        cmd_insert(argv[2], maybe_target, text);
        free(text); return 0;
    }
    if (strcmp(cmd, "focus") == 0) {
        if (argc < 3) { fprintf(stderr, "Usage: atspi focus <app>\n"); return 1; }
        char *n = join_args(argc, argv, 2); cmd_focus(n); free(n); return 0;
    }
    if (strcmp(cmd, "open") == 0) {
        if (argc < 3) { fprintf(stderr, "Usage: atspi open <command>\n"); return 1; }
        char *c = join_args(argc, argv, 2); cmd_open(c); free(c); return 0;
    }
    if (strcmp(cmd, "close") == 0) {
        if (argc < 3) { fprintf(stderr, "Usage: atspi close <app>\n"); return 1; }
        char *n = join_args(argc, argv, 2); cmd_close(n); free(n); return 0;
    }

    /* "apps" — fast D-Bus path, fallback to libatspi */
    if (strcmp(cmd, "apps") == 0) {
        if (!cmd_apps_fast()) {
            atspi_lazy_init();
            cmd_apps_atspi();
        }
        return 0;
    }

    /* remaining commands need libatspi */
    if (strcmp(cmd, "read") == 0) {
        cmd_read(argc > 2 ? argv[2] : NULL, 0);
    } else if (strcmp(cmd, "read-raw") == 0) {
        cmd_read(argc > 2 ? argv[2] : NULL, 1);
    } else if (strcmp(cmd, "find") == 0) {
        if (argc < 4) { fprintf(stderr, "Usage: atspi find <app> <pattern>\n"); return 1; }
        char *pattern = join_args(argc, argv, 3);
        cmd_find(argv[2], pattern); free(pattern);
    } else if (strcmp(cmd, "interact") == 0) {
        cmd_interact(argc > 2 ? argv[2] : NULL);
    } else if (strcmp(cmd, "click") == 0) {
        if (argc < 4) { fprintf(stderr, "Usage: atspi click <app> <element_name>\n"); return 1; }
        char *elem = join_args(argc, argv, 3);
        cmd_click(argv[2], elem); free(elem);
    } else if (strcmp(cmd, "snap") == 0) {
        char *n = argc > 2 ? join_args(argc, argv, 2) : NULL;
        cmd_snap(n);
        free(n);
    } else {
        fprintf(stderr, "Unknown command: %s\n", cmd);
        usage(); return 1;
    }
    return 0;
}
