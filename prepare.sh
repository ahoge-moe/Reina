#!/bin/bash

cd bin
wget "https://downloads.rclone.org/rclone-current-linux-amd64.zip"
unzip "rclone-current-linux-amd64.zip"
rm "rclone-current-linux-amd64.zip"
cd */
mv rclone ../
cd ..
rm -rf rclone*/