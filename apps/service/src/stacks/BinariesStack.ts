import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib"
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3"
import type { Construct } from "constructs"

export class BinariesStack extends Stack {
	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props)

		const bucket = new Bucket(this, "Bucket", {
			bucketName: "buffered-audio-binaries-345340320424",
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
		})

		new CfnOutput(this, "BucketName", {
			value: bucket.bucketName,
		})

		new CfnOutput(this, "BucketRegionalDomainName", {
			value: bucket.bucketRegionalDomainName,
		})
	}
}
