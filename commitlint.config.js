export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"body-max-line-length": [0],
		"footer-max-line-length": [0],
		"planner-footers": [2, "always"],
		"planner-plan-footer": [1, "always"],
	},
	// Footer token shapes are defined in Git (src/index.md#git).
	plugins: [
		{
			rules: {
				"planner-footers": ({ raw }) => {
					const lines = (raw ?? "").split(/\r?\n/);
					for (const line of lines) {
						if (/^Supersedes:/.test(line) && !/^Supersedes: [0-9a-f]{7,40}; .+/.test(line)) {
							return [false, line];
						}
						if (/^Rejected:/.test(line) && !/^Rejected: [^;]+; .+/.test(line)) {
							return [false, line];
						}
					}
					return [true];
				},
				"planner-plan-footer": ({ raw }) => {
					const lines = (raw ?? "").split(/\r?\n/);
					for (const line of lines) {
						if (/^Plan:/.test(line) && !/^Plan: [\w.-]+$/.test(line)) {
							return [false, line];
						}
					}
					return [true];
				},
			},
		},
	],
};
