const amqp = require('amqplib')
const logger = require('logger')
const { exec } = require('child_process')
const { readFileSync, rmSync } = require('fs')
const { rabbitmq: { inbound, outbound }, rclone: { dest } } = require('@iarna/toml').parse(readFileSync('config/config.toml'))

const downloadFile = job => {
  return new Promise((resolve, reject) => {
    const { title, link, show } = job

    const command = [
      `bin/aria2c`,
      `-d temp`,
      `--seed-time=0`,
      `--rpc-save-upload-metadata=false`,
      `"${link}"`,
    ]
    const subprocess = exec(command.join(' '), { cwd: process.cwd() })
    subprocess.on('close', code => {
      if (code === 13) {
        // If file already existed. This can happen when channel to RabbitMQ is closed because of ack timeout.
        // The next time Reina is boot up, aria2c might try to download the same file again even though it's already completed.
        logger.debug(`Exit code ${code}`) 
        resolve()
      }
      if (code != 0) return reject()
      resolve()
    })
  })
}

const mkdir = job => {
  return new Promise((resolve, reject) => {
    const { title, link, show } = job

    const command = [
      `bin/rclone`,
      `mkdir`,
      `"${dest}:放送中/${show}"`,
      `--config config/rclone.conf`
    ]
    const subprocess = exec(command.join(' '), { cwd: process.cwd() })
    subprocess.on('close', code => {
      if (code != 0) return reject()
      resolve()
    })
  })
}

const uploadFile = job => {
  return new Promise((resolve, reject) => {
    const { title, link, show } = job

    const command = [
      `bin/rclone`,
      `copy`,
      `"temp/${title}"`,
      `"${dest}:放送中/${show}"`,
      `--config config/rclone.conf`
    ]
    const subprocess = exec(command.join(' '), { cwd: process.cwd() })
    subprocess.on('close', code => {
      if (code != 0) return reject()
      resolve()
    })
  })
}

const emptyTempFolder = () => {
  return new Promise((resolve, reject) => {
    rmSync(`temp`, { recursive: true, force: true })
    resolve()
  })
}

const parseMessage = content => {
  // Message is the magnet link itself
  if (content.toString().startsWith('magnet')) {
    const magnetLink = new URL(content.toString())
    const filename = magnetLink.searchParams.get('dn')

    const showAndEp = filename.replace(/^\[SubsPlease\] | \([0-9]+p\) \[[0-9A-Z]+\]\.mkv$/g, '')
    const resolution = filename.match(/\([0-9]+p\)/)?.[0].replace(/\(|\)|p/g, '')
    const episodeRegex = /- [0-9]+((v|\.)[0-9]+)*$/
    // if episode number is present, then replace episode number with resolution
    // if episode number is missing, then concat show name with resolution
    const normalizedShowName = showAndEp.match(episodeRegex) ? showAndEp.replace(episodeRegex, `- ${resolution}`) : `${showAndEp} - ${resolution}`

    return {
      title: filename,
      link: content.toString(),
      show: normalizedShowName
    }
  }

  return JSON.parse(content)
}

;(async () => {
  try {
    logger.info(`Connecting to RabbitMQ`)
    const connection = await amqp.connect(inbound)
    const channel = await connection.createChannel()
    logger.success(`Connection to RabbitMQ established`)

    await channel.prefetch(1)
    
    logger.info(`Checking inbound queue`)
    await channel.checkQueue(inbound.queue)
    logger.success(`Inbound queue confirmed`)

    logger.info(`Asserting outbout exchange`)
    await channel.assertExchange(outbound.exchange, 'direct')
    logger.success(`Outbout exchange asserted`)

    logger.info(`Asserting outbound queue`)
    await channel.assertQueue(outbound.queue)
    logger.success(`Outbound queue asserted`)

    logger.info(`Binding outbound exchange to outbound queue`)
    await channel.bindQueue(outbound.queue, outbound.exchange, outbound.routingKey)
    logger.success(`Binding established`)
  
    logger.info(`Awaiting for messages`)
    await channel.consume(inbound.queue, async msg => {
      // msg is null when queue is deleted or if channel.cancel() is called
      if (msg == null) {
        logger.error(`Inbound queue has been deleted`)
        await connection.close()
      }
  
      try {
        logger.success(`Message received`)

        const job = parseMessage(msg.content)
        console.log(job)
        
        logger.info(`Downloading...`)
        await downloadFile(job)
        logger.success(`Downloaded`)
        
        logger.info(`Creating folder...`)
        await mkdir(job)
        logger.success(`Created`)

        logger.info(`Uploading...`)
        await uploadFile(job)
        logger.success(`Uploaded`)
        
        logger.info(`Ack'ing inbound message`)
        await channel.ack(msg)
        logger.success(`Ack'ed`)
        
        logger.info(`Emptying temp folder`)
        await emptyTempFolder()
        logger.success(`Temp folder emptied`)
        
        logger.info(`Publishing ${job.title}`)
        await channel.publish(
          outbound.exchange,
          outbound.routingKey,
          Buffer.from(JSON.stringify(job)),
          { persistent: true }
        )
        logger.success(`Published`)
      }
      catch (e) {
        logger.error(e)  

        logger.info(`Nack'ing inbound message`)
        await channel.nack(msg, false, true)
        logger.success(`Nack'ed`)
      }
    })  
  }
  catch (e) {
    logger.error(e)
  }
})()