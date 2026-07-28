import { Stack, type StackProps } from "aws-cdk-lib";
import { addPublicAssetBucket } from "./utils/public-asset-bucket";
import type { Construct } from "constructs";

export class FixturesStack extends Stack {
	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);

		addPublicAssetBucket(this, "buffered-audio-test-fixtures-345340320424");
	}
}
