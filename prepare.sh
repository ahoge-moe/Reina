#!/bin/bash

mkdir -p bin
cd bin

if [ -f rclone ]; then
  echo "Rclone binary found"
else
  echo "Downloading rclone"
  wget "https://downloads.rclone.org/rclone-current-linux-amd64.zip"
  unzip "rclone-current-linux-amd64.zip"
  rm "rclone-current-linux-amd64.zip"
  cd */
  mv rclone ../
  cd ..
  rm -rf rclone*/
fi

cd ..
npm i