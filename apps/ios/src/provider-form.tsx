import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { add, update, type Member } from "./account.ts";
import { appError, failureOf, hostOf, type Failure } from "./errors.ts";
import { colors, TextButton } from "./ui.tsx";

/** Connect adds the first provider, Settings the next ones, and edits a saved one. */
export type FormMode =
  | { readonly kind: "connect" }
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly member: Member };

const LABELS = {
  connect: { idle: "Connect", busy: "Connecting" },
  add: { idle: "Add", busy: "Adding" },
  edit: { idle: "Save", busy: "Saving" },
} as const;

/**
 * One form for a provider's login. A failure keeps every field and says what happened and what
 * to do; the button becomes Try again with the same details until a field changes, which clears
 * the failure. The provider checks the login before anything is saved. Editing changes the name,
 * and the password when one is typed: another server or username is another provider, added.
 * Leaving the form before its answer cancels it, and nothing is saved.
 */
export function ProviderForm({ mode, onDone }: { mode: FormMode; onDone?: () => void }) {
  const saved = mode.kind === "edit" ? mode.member.entry : null;
  const [name, setName] = useState(saved?.name ?? "");
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The line under the fields, when it is the failure of the details as they stand.
  const [failure, setFailure] = useState<Failure | null>(null);
  // Counts edits, so a sign-in that fails after the fields changed says nothing about them.
  const edits = useRef(0);
  // The keyboard's Go submits too, and can before `busy` renders: one sign-in at a time.
  const pending = useRef(false);
  const leaving = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, []);

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    edits.current += 1;
    setFailure(null);
  };

  const submit = () => {
    if (pending.current) return;
    pending.current = true;
    const submitted = edits.current;
    const { signal } = leaving.current;
    setBusy(true);
    setFailure(null);
    const saving = saved
      ? update(saved.id, { name, ...(password ? { password } : {}) }, signal)
      : add({ server, username, password, ...(mode.kind === "add" ? { name } : {}) }, signal);
    saving.then(
      () => {
        pending.current = false;
        if (!signal.aborted) onDone?.();
      },
      (cause: unknown) => {
        pending.current = false;
        if (signal.aborted) return;
        setBusy(false);
        if (edits.current !== submitted) return;
        setFailure(failureOf(appError(cause), saved?.server ?? server));
      },
    );
  };

  const prefix = mode.kind === "connect" ? "connect" : "provider";
  const label = LABELS[mode.kind];
  return (
    <>
      {mode.kind === "connect" ? null : (
        <Field label="Name" value={name} onChange={edit(setName)} prefix={prefix} optional />
      )}
      {saved ? (
        <Text style={styles.account} numberOfLines={2}>
          {`${hostOf(saved.server)} · ${saved.username}`}
        </Text>
      ) : (
        <>
          <Field
            label="Server"
            value={server}
            onChange={edit(setServer)}
            placeholder="http://line.example.com:8080"
            keyboard="url"
            prefix={prefix}
          />
          <Field label="Username" value={username} onChange={edit(setUsername)} prefix={prefix} />
        </>
      )}
      <Field
        label="Password"
        value={password}
        onChange={edit(setPassword)}
        placeholder={mode.kind === "edit" && !mode.member.needsSecret ? "Unchanged" : undefined}
        secret
        onSubmit={submit}
        prefix={prefix}
      />
      {failure ? (
        <View accessible accessibilityLiveRegion="polite" testID={`${prefix}-error`}>
          <Text style={styles.error}>{failure.headline}</Text>
          {failure.advice ? <Text style={styles.advice}>{failure.advice}</Text> : null}
        </View>
      ) : null}
      <TextButton
        label={busy ? label.busy : failure ? "Try again" : label.idle}
        onPress={submit}
        disabled={busy}
      />
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  keyboard,
  onSubmit,
  optional,
  prefix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  secret?: boolean;
  keyboard?: "url";
  onSubmit?: () => void;
  optional?: boolean;
  prefix: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? (optional ? "Optional" : undefined)}
        placeholderTextColor="#636366"
        secureTextEntry={secret ?? false}
        textContentType={secret ? "password" : keyboard ? "URL" : optional ? "none" : "username"}
        keyboardType={keyboard === "url" ? "url" : "default"}
        autoCapitalize={optional ? "sentences" : "none"}
        autoCorrect={false}
        returnKeyType={onSubmit ? "go" : "next"}
        onSubmitEditing={onSubmit}
        style={styles.input}
        testID={`${prefix}-${label.toLowerCase()}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 15, fontWeight: "600" },
  input: {
    minHeight: 44,
    color: colors.text,
    fontSize: 17,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  account: { color: colors.text, fontSize: 17 },
  error: { color: "#FF453A", fontSize: 15, fontWeight: "600" },
  advice: { color: colors.text, fontSize: 15, marginTop: 2 },
});
