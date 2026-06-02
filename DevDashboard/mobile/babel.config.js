module.exports = (api) => {
    api.cache(true);

    return {
        presets: [
            ["babel-preset-expo", { jsxImportSource: "nativewind" }],
            "nativewind/babel",
        ],
        // react-native-worklets/plugin MUST be last (reanimated 4 / worklets 0.7.4 requirement).
        plugins: ["react-native-worklets/plugin"],
    };
};
