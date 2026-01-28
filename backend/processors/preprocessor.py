from abc import abstractmethod
import boto3
from botocore.client import Config
from configs.common import S3_ENDPOINT_URL,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY
from botocore.exceptions import ClientError
from tqdm import tqdm
import os

class Preprocessor:
    NOT_FOUND_EXCEPTION_CODE = 404

    cameras = [
        "FRONT",
        "FRONT_LEFT",
        "FRONT_RIGHT",
        "REAR",
        "BACK_LEFT",
        "BACK_RIGHT"
    ]

    def __init__(self):
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

    def ensure_bucket(self, bucket: str):
        try:
            self.s3.head_bucket(Bucket=bucket)
        except ClientError as e:
            error_code = int(e.response["Error"]["Code"])
            if error_code == self.NOT_FOUND_EXCEPTION_CODE:
                self.s3.create_bucket(Bucket=bucket)
            else:
                raise

    def upload_to_s3(self, local_path: str, bucket: str, object_name: str):
        self.s3.upload_file(
            Filename=local_path,
            Bucket=bucket,
            Key=object_name
        )

    @abstractmethod
    def __iter__(self):
        raise NotImplementedError("Dataset preprocessor must have __iter__")

    @abstractmethod
    def __next__(self):
        raise NotImplementedError("Dataset preprocessor must have __next__")

    def download_to_s3(self, bucket: str = "avsp"):
        self.ensure_bucket(bucket=bucket)
        for episode_df in tqdm(self):
            for row in episode_df.itertuples(index=False):
                local_path = getattr(row, "image_path")
                name = os.path.basename(local_path)
                self.upload_to_s3(local_path, bucket, name)
                os.remove(local_path)
