import { App } from "aws-cdk-lib"
import { BinariesStack } from "./stacks/BinariesStack"
import { FixturesStack } from "./stacks/FixturesStack"

const app = new App()

const env = { account: "345340320424", region: "us-east-1" }

new BinariesStack(app, "Binaries", { env })
new FixturesStack(app, "Fixtures", { env })
