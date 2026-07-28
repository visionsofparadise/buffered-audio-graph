import { CfnOutput, RemovalPolicy, type Stack } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";

export function addPublicAssetBucket(stack: Stack, bucketName: string): void {
	const bucket = new Bucket(stack, "Bucket", {
		bucketName,
		publicReadAccess: true,
		blockPublicAccess: new BlockPublicAccess({
			blockPublicAcls: false,
			ignorePublicAcls: false,
			blockPublicPolicy: false,
			restrictPublicBuckets: false,
		}),
		versioned: true,
		encryption: BucketEncryption.S3_MANAGED,
		removalPolicy: RemovalPolicy.RETAIN,
	});

	new CfnOutput(stack, "BucketName", {
		value: bucket.bucketName,
	});

	new CfnOutput(stack, "BucketRegionalDomainName", {
		value: bucket.bucketRegionalDomainName,
	});
}
