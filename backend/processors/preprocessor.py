import boto3
from botocore.client import Config
from configs.common import S3_ENDPOINT_URL,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY
from botocore.exceptions import ClientError

class Preprocessor:
    cameras = [
        "FRONT",
        "FRONT_LEFT",
        "FRONT_RIGHT",
        "REAR",
        "BACK_LEFT",
        "BACK_RIGHT"
    ]

    def __init__(self , s3_bucket="avsp"):
        self.s3_bucket=s3_bucket
        self.s3 = boto3.client(
            "s3",
            endpoint_url=S3_ENDPOINT_URL,
            aws_access_key_id=S3_ACCESS_KEY_ID,
            aws_secret_access_key=S3_SECRET_ACCESS_KEY,
            region_name="us-east-1",
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
            ),
        )
        self.ensure_bucket(self.s3_bucket)
        


    def upload_to_s3(self, local_path: str, object_name: str):
        self.s3.upload_file(
            Filename=local_path,
            Bucket=self.s3_bucket,
            Key=object_name
        )

    def ensure_bucket(self, bucket: str):
        try:
            self.s3.head_bucket(Bucket=bucket)
        except ClientError as e:
            error_code = int(e.response["Error"]["Code"])
            if error_code == 404:
                self.s3.create_bucket(Bucket=bucket)
            else:
                raise

