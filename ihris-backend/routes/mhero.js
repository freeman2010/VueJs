const express = require("express");
const router = express.Router();
const moment = require("moment")
const async = require("async");
const axios = require("axios");
const lodash = require("lodash")
const URI = require("urijs");
const { v4: uuidv4 } = require('uuid')
const ihrissmartrequire = require('ihrissmartrequire')
const es = require("../modules/es")
const nconf = require('../modules/config')
const fhirReports = require('../modules/fhir/fhirReports')
const fhirAudit = require('../modules/fhir/fhirAudit')
const logger = require('../winston')
const fhirAxios = nconf.fhirAxios

const outcomes = ihrissmartrequire('config/operationOutcomes')

/**
 * Send message
 */
router.post("/send-message", function (req, res) {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  logger.info('Sending mhero message')
  let errorOccured = false
  let data = req.body
  let practitioners = []
  let preparePractitioners = new Promise((resolve) => {
    if(!data.sendToMatchingTerms) {
      practitioners = data.practitioners
      return resolve()
    }
    es.getData({
      indexName: data.reportData.indexName,
      searchQuery: data.builtTerms
    }, (err, practs) => {
      if(err) {
        errorOccured = true
        return resolve()
      }
      if(!Array.isArray(practs) || practs.length === 0) {
        errorOccured = true
        return resolve()
      }
      practitioners = practs
      resolve()
    })
  })

  let parentReqId = uuidv4()
  let meta = {
    tag: [{
      system: "parentReqId",
      code: parentReqId
    }]
  }
  preparePractitioners.then(() => {
    if(errorOccured) {
      return res.status(500).send()
    }
    let messageKey
    let payload = []
    if (data.workflow) {
      messageKey = data.workflow
      payload.push({
        contentReference: {
          reference: 'Basic/' + data.workflow
        }
      })
    } else if (data.sms) {
      messageKey = data.sms
      payload.push({
        contentString: data.sms
      })
    }
    let communicationReq = {
      meta,
      payload,
      recipient: [],
      resourceType: "CommunicationRequest",
      id: uuidv4()
    };
    if(data.frequency === 'recurring' || (data.frequency === 'once' && data.sendTimeCategory === 'later')) {
      if(!communicationReq.meta) {
        communicationReq.meta = {}
      }
      if(!communicationReq.meta.profile) {
        communicationReq.meta.profile = []
      }
      if(!communicationReq.extension) {
        communicationReq.extension = []
      }
      communicationReq.meta.profile.push("http://mhero.org/fhir/StructureDefinition/mhero-communication-request")
      let extension = []
      let freq = {
        url: 'frequency',
        valueString: data.frequency
      }
      extension.push(freq)
      if(data.sendTimeCategory) {
        extension.push({
          url: 'sendCategory',
          valueString: data.sendTimeCategory
        })
      }
      extension.push({
        url: 'cronExpression',
        valueString: data.cronExpression
      })
      communicationReq.extension.push({
        url: "http://mhero.org/fhir/StructureDefinition/sms-cron-expression-schedule",
        extension
      })
    } else {
      communicationReq.occurrenceDateTime = moment().format("YYYY-MM-DDTHH:mm:ss")
    }
    if(!communicationReq.extension) {
      communicationReq.extension = []
    }
    communicationReq.extension.push({
      url: 'sender',
      valueReference: {
        reference: req.user.resource.resourceType + '/' + req.user.resource.id
      }
    })
    let recipients = [];
    let childrenReqIDs = [];
    async.each(practitioners, (practitioner, nxt) => {
      if(data.sendToMatchingTerms) {
        practitioner = practitioner._source[data.reportData.indexName].split('/')
        if(practitioner.length === 2) {
          practitioner = practitioner[1]
        } else {
          practitioner = practitioner._source[data.reportData.indexName]
        }
      }
      recipients.push({
        reference: "Practitioner/" + practitioner
      });
      if(recipients.length > 10000) {
        let tmpRecipients = lodash.cloneDeep(recipients)
        let tmpCommunicationReq = lodash.cloneDeep(communicationReq)
        tmpCommunicationReq.recipient = tmpRecipients
        recipients = []
        let url = URI(nconf.get("emnutt:base")).segment('CommunicationRequest');
        axios.post(url.toString(), tmpCommunicationReq, {
          withCredentials: true,
          auth: {
            username: nconf.get("emnutt:username"),
            password: nconf.get("emnutt:password")
          }
        }).then((sendStatus) => {
          childrenReqIDs.push(sendStatus.data.reqID)
          return nxt()
        }).catch(err => {
          logger.error(err.message)
          errorOccured = true
          return nxt()
        });
      } else {
        return nxt()
      }
    }, () => {
      if(recipients.length > 0) {
        communicationReq.recipient = recipients
        let url = URI(nconf.get("emnutt:base")).segment('CommunicationRequest');
        axios.post(url.toString(), communicationReq, {
          withCredentials: true,
          auth: {
            username: nconf.get("emnutt:username"),
            password: nconf.get("emnutt:password")
          }
        }).then((sendStatus) => {
          childrenReqIDs.push(sendStatus.data.reqID)
          if(errorOccured) {
            return res.status(500).json({childrenReqIDs, parentReqId})
          }
          res.status(201).json({childrenReqIDs, parentReqId})
        }).catch(err => {
          logger.error(err.message)
          return res.status(500).json({childrenReqIDs, parentReqId})
        });
      } else {
        if(errorOccured) {
          return res.status(500).json({childrenReqIDs, parentReqId})
        }
        res.status(201).json({childrenReqIDs, parentReqId});
      }
    })
  })
});

router.get('/getProgress', (req, res) => {
  let url = URI(nconf.get("emnutt:base")).segment('getProgress').toString();
  axios({
    url,
    params: {
      requestIDs: req.query.requestIDs
    },
    withCredentials: true,
    auth: {
      username: nconf.get("emnutt:username"),
      password: nconf.get("emnutt:password")
    }
  }).then((resp) => {
    return res.json(resp.data)
  }).catch((err) => {
    console.log(err);
    return res.status(500).send()
  })
});

router.get('/clearProgress', (req, res) => {
  let url = URI(nconf.get("emnutt:base")).segment('clearProgress').toString();
  axios({
    url,
    params: {
      requestIDs: req.query.requestIDs
    },
    withCredentials: true,
    auth: {
      username: nconf.get("emnutt:username"),
      password: nconf.get("emnutt:password")
    }
  }).then((resp) => {
    return res.json(resp.data)
  }).catch((err) => {
    console.log(err);
    return res.status(500).send()
  })
});

router.post('/cancel-message-schedule', (req, res) => {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let schedules = req.body.schedules
  let url = URI(nconf.get("emnutt:base")).segment('cancelMessageSchedule');
  axios.post(url.toString(), {schedules}, {
    withCredentials: true,
    auth: {
      username: nconf.get("emnutt:username"),
      password: nconf.get("emnutt:password")
    }
  }).then(response => {
    for(let schedule of schedules) {
      fhirAudit.update( req.user, req.ip, schedule, true )
    }
    res.status(200).json({childrenReqIDs: [response.data.reqID]});
  }).catch(err => {
    for(let schedule of schedules) {
      fhirAudit.update( req.user, req.ip, schedule, false )
    }
    res.status(500).send(err);
  });
})

router.post('/subscribe-contact-groups', (req, res) => {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let subscriptionsData = req.body
  let errorOccured = false
  async.eachSeries(subscriptionsData.groups, (groupID, nxtSubscr) => {
    fhirAxios.read('Group', groupID).then((groupResource) => {
      for(let memberID of subscriptionsData.members) {
        let exist = groupResource.member && groupResource.member.find((member) => {
          return member.entity.reference === memberID
        })
        if(!exist) {
          if(!groupResource.member) {
            groupResource.member = []
          }
          groupResource.member.push({
            entity: {
              reference: memberID
            }
          })
        }
      }
      fhirAxios.update(groupResource).then((response) => {
        fhirAudit.update( req.user, req.ip, response.resourceType + "/" + response.id
        + (response.meta.versionId ? "/_history/"+response.meta.versionId : ""), true )
        return nxtSubscr();
      }).catch((err) => {
        console.log(err);
        errorOccured = true
        fhirAudit.update( req.user, req.ip, groupResource.resourceType + "/" + groupResource.id, false, { resource: groupResource, err: err } )
        return nxtSubscr();
      })
    })
  }, () => {
    if(errorOccured) {
      return res.status(500).send()
    }
    fhirReports.setup().then(() => {
      fhirReports.runReports()
    }).catch((err) => {
      logger.error( err.message )
    })
    return res.status(200).send()
  })
})

router.post('/add-group', (req, res) => {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let name = req.body.name
  let resource = {
    resourceType: 'Group',
    name,
  }
  fhirAxios.create(resource).then(async(response) => {
    fhirAudit.create( req.user, req.ip, response.resourceType + "/" + response.id
        + (response.meta.versionId ? "/_history/"+response.meta.versionId : ""), true )
    try {
      let reportsRunning = await fhirReports.setup()
      if ( reportsRunning ) {
        fhirReports.runReports()
      } else {
        logger.error("Failed to start up reports to ElasticSearch.")
      }
    } catch( err ) {
      logger.error( err.message )
    }
    return res.status(201).send()
  }).catch((err) => {
    logger.error(err.message);
    return res.status(500).send()
  })
})

router.post('/unsubscribe-contact-groups', (req, res) => {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let errorOccured = false
  let subscriptionsData = req.body
  async.eachSeries(subscriptionsData.groups, (groupID, nxtSubscr) => {
    fhirAxios.read('Group', groupID).then((groupResource) => {
      for(let memberID of subscriptionsData.members) {
        for(let index in groupResource.member) {
          if(groupResource.member[index].entity.reference === memberID) {
            groupResource.member.splice(index, 1)
          }
        }
      }
      fhirAxios.update(groupResource).then((response) => {
        fhirAudit.update( req.user, req.ip, response.resourceType + "/" + response.id
        + (response.meta.versionId ? "/_history/"+response.meta.versionId : ""), true )
        return nxtSubscr();
      }).catch((err) => {
        fhirAudit.update( req.user, req.ip, groupResource.resourceType + "/" + groupResource.id, false, { resource: groupResource, err: err } )
        errorOccured = true
      })
    })
  }, () => {
    if(errorOccured) {
      return res.status(500).send()
    }
    fhirReports.setup().then(() => {
      fhirReports.runReports()
    }).catch((err) => {
      logger.error( err.message )
    })
    return res.status(200).send()
  })
})

router.put('/optout', (req, res) => {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let url = URI(nconf.get("emnutt:base").replace('/fhir', '')).segment('optout');
  axios.put(url.toString(), req.body, {
    withCredentials: true,
    auth: {
      username: nconf.get("emnutt:username"),
      password: nconf.get("emnutt:password")
    }
  }).then((response) => {
    if(Array.isArray(response)) {
      for(let entry of response) {
        if(entry.response && entry.response.location) {
          fhirAudit.update( req.user, req.ip, entry.response.location, true )
        }
      }
    }
    return res.status(200).send()
  }).catch(err => {
    logger.error(err.message)
    return res.status(500).send()
  });
})

router.put('/undoOptout', (req, res) => {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let url = URI(nconf.get("emnutt:base").replace('/fhir', '')).segment('undoOptout');
  axios.put(url.toString(), req.body, {
    withCredentials: true,
    auth: {
      username: nconf.get("emnutt:username"),
      password: nconf.get("emnutt:password")
    }
  }).then((response) => {
    if(Array.isArray(response)) {
      for(let entry of response) {
        if(entry.response && entry.response.location) {
          fhirAudit.update( req.user, req.ip, entry.response.location, true )
        }
      }
    }
    return res.status(200).send()
  }).catch(err => {
    logger.error(err.message)
    return res.status(500).send()
  });
})

/**
 * Get all workflows
 */
router.get("/workflows", function (req, res, next) {
  if ( !req.user ) {
    return res.status(401).json( outcomes.NOTLOGGEDIN )
  }
  let queries = {
    '_profile': 'http://mhero.org/fhir/StructureDefinition/mhero-workflows'
  }
  let resourceType = 'Basic'
  let resourceData = []
  async.whilst(callback => {
    return callback(null, Object.keys(queries).length > 0);
  }, callback => {
    fhirAxios.search(resourceType, queries).then((searchBundle) => {
      if(searchBundle.entry) {
        resourceData = resourceData.concat(searchBundle.entry)
      }
      queries = {}
      const next = searchBundle.link && searchBundle.link.find(link => link.relation === 'next');
      if (next) {
        let urlObj = new URL(next.url)
        urlObj.searchParams.forEach((value, name) => {
          queries[name] = value
        })
        resourceType = ''
      }
      return callback(null, queries)
    })
  }, (err) => {
    if (err) {
      return res.status(500).send();
    }
    let workflows = []
    for (let data of resourceData) {
      workflow = data.resource && data.resource.extension && data.resource.extension.find((ext) => {
        return ext.url === "http://mhero.org/fhir/StructureDefinition/mhero-workflows-details"
      })
      if (workflow) {
        let name = workflow.extension.find((ext) => {
          return ext.url === "name"
        })
        workflows.push({
          text: name.valueString,
          id: data.resource.id
        })
      }
    }
    return res.status(200).json(workflows);
  })
});

module.exports = router;
