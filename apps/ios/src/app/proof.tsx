import { Redirect } from "expo-router";

// The runtime proof is a development screen. In a release build `__DEV__` is false and Metro folds
// this condition away before it collects imports, so the proof and its cases stay out of the
// shipped bundle, and a link to this route opens the app instead.
export default __DEV__
  ? (require("../proof/screen.tsx") as typeof import("../proof/screen.tsx")).ProofScreen
  : function NoProof() {
      return <Redirect href="/" />;
    };
