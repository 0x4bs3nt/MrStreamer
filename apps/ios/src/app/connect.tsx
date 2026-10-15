import { router } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { connect, useSession } from "../account.ts";
import { appError, describeError } from "../errors.ts";
import { colors, TextButton } from "../ui.tsx";

/** Signs in to an Xtream subscription. The root layout shows the tabs once it is. */
export default function Connect() {
  const session = useSession();
  const saved = session.kind === "signed-out" ? session.saved : null;
  const [server, setServer] = useState(saved?.server ?? "");
  const [username, setUsername] = useState(saved?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(saved ? "Enter the password again." : null);
  // The keyboard's Go submits too, and can before `busy` renders: one sign-in at a time.
  const pending = useRef(false);

  const submit = () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    connect({ server, username, password }).catch((cause: unknown) => {
      pending.current = false;
      setBusy(false);
      setError(describeError(appError(cause)));
    });
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title} accessibilityRole="header">
        Mr. Streamer
      </Text>
      <Field
        label="Server"
        value={server}
        onChange={setServer}
        placeholder="http://line.example.com:8080"
        keyboard="url"
      />
      <Field label="Username" value={username} onChange={setUsername} />
      <Field label="Password" value={password} onChange={setPassword} secret onSubmit={submit} />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="connect-error">
          {error}
        </Text>
      ) : null}
      <TextButton label={busy ? "Connecting" : "Connect"} onPress={submit} disabled={busy} />
      {__DEV__ ? <TextButton label="Runtime proof" onPress={() => router.push("/proof")} /> : null}
    </ScrollView>
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
  keyboard?: "url";
  onSubmit?: () => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#636366"
        secureTextEntry={secret ?? false}
        textContentType={secret ? "password" : keyboard ? "URL" : "username"}
        keyboardType={keyboard === "url" ? "url" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType={onSubmit ? "go" : "next"}
        onSubmitEditing={onSubmit}
        style={styles.input}
        testID={`connect-${label.toLowerCase()}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { padding: 24, gap: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700", marginBottom: 8 },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 15, fontWeight: "600" },
  input: {
    minHeight: 44,
    color: colors.text,
    fontSize: 17,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  error: { color: "#FF453A", fontSize: 15 },
});
