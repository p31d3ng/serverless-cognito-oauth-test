const AWS = require('aws-sdk');
const axios = require('axios');

const RESOURCE_SERVER_NAME = process.env.OAUTH_CLIENT_NAME + '-resource';
const RESOURCE_SCOPES = ['admin:full', 'developer:read', 'developer:write'];
const ALLOWED_OATUH_SCOPES = ['admin:full'];
const USER_POOL_REF = "UserPoolID";

module.exports.handler = async (event, context) => {
    if (event.RequestType === "Delete") {
        return await sendResponse(event, context, "SUCCESS", "SUCCESS");
    }

    if (!(USER_POOL_REF in event.ResourceProperties)) {
        return await sendResponse(event, context, "FAILED", USER_POOL_REF + " is required in properties!");
    }        
    
    const cognito_isp = new AWS.CognitoIdentityServiceProvider({apiVersion: '2016-04-18', region: process.env.REGION});

    try {
        const rslt = await Promise.all([
            oauth_client_exists(event.ResourceProperties[USER_POOL_REF], cognito_isp),
            get_current_domain(event.ResourceProperties[USER_POOL_REF], cognito_isp)
        ]);
        // console.log(rslt, event.ResourceProperties);
        const promises = [];
        if (!rslt[0]) {
            promises.push(configure_oauth(event.ResourceProperties[USER_POOL_REF], cognito_isp));
        }
        if (typeof rslt[1]  === "undefined") {
            promises.push(setup_domain(event.ResourceProperties[USER_POOL_REF], cognito_isp));
        }
        if (promises.length === 0) {
            return sendResponse(event, context, "SUCCESS", "Already configured, skipping the process...");
        }
        await Promise.all(promises);
    } catch (err) {
        console.log(err);
        return await sendResponse(event, context, "FAILED", err.toString());
    }

    return await sendResponse(event, context, "SUCCESS", "successful built an oauth client");
};

const oauth_client_exists = async (user_pool_id, cognito_isp) => {
    const user_pool_clients = await cognito_isp.listUserPoolClients({UserPoolId: user_pool_id}).promise();
    const exists = user_pool_clients.UserPoolClients.findIndex(x => x.ClientName === process.env.OAUTH_CLIENT_NAME);
    if (exists === -1) return false;
    return true;
};

const get_current_domain = async (user_pool_id, cognito_isp) => {
    const user_pool_details = await cognito_isp.describeUserPool({UserPoolId: user_pool_id}).promise();
    return user_pool_details.UserPool.Domain;
};

const configure_oauth = async (user_pool_id, cognito_isp) => {
    await create_resource_server(user_pool_id, cognito_isp);
    await build_oauth_client(user_pool_id, cognito_isp);
};

const build_oauth_client = async (user_pool_id, cognito_isp) => {
    const param = {
        ClientName: process.env.OAUTH_CLIENT_NAME,
        UserPoolId: user_pool_id,
        AllowedOAuthFlows: ['client_credentials'],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: ALLOWED_OATUH_SCOPES.map(x => RESOURCE_SERVER_NAME + '/' + x),
        SupportedIdentityProviders: ['COGNITO'],
        GenerateSecret: true
    };
    return cognito_isp.createUserPoolClient(param).promise();
};

const create_resource_server = async (user_pool_id, cognito_isp) => {
    const param = {
        UserPoolId: user_pool_id,
        Identifier: RESOURCE_SERVER_NAME,
        Name: RESOURCE_SERVER_NAME,
        Scopes: RESOURCE_SCOPES.map(x => ({ScopeDescription: x, ScopeName: x}))
    };
    return cognito_isp.createResourceServer(param).promise();
};

const setup_domain = async (user_pool_id, cognito_isp) => {
    const param = {
        Domain: process.env.DOMAIN_PREFIX + "-" + generateUID(),
        UserPoolId: user_pool_id
    };
    return cognito_isp.createUserPoolDomain(param).promise();
};

const generateUID = () => {
    let firstPart = (Math.random() * 46656) | 0;
    let secondPart = (Math.random() * 46656) | 0;
    firstPart = ("000" + firstPart.toString(36)).slice(-3);
    secondPart = ("000" + secondPart.toString(36)).slice(-3);
    return firstPart + secondPart;
};

const sendResponse = async (
    event,
    context,
    responseStatus,
    responseData,
    physicalResourceId
  ) => {
    const reason =
      responseStatus == "FAILED" ?
        "See the details in CloudWatch Log Stream: " + context.logStreamName : undefined;
  
    const responseBody = JSON.stringify({
        StackId: event.StackId,
        RequestId: event.RequestId,
        Status: responseStatus,
        Reason: reason,
        PhysicalResourceId: physicalResourceId || context.logStreamName,
        LogicalResourceId: event.LogicalResourceId,
        Data: {
            content: responseData
        }
    });
  
    const responseOptions = {
        headers: {
            "Content-Type": "",
            "Content-Length": responseBody.length
        }
    };
  
    console.info("Response body:\n", responseBody);
  
    try {
        await axios.put(event.ResponseURL, responseBody, responseOptions);
        console.info("CloudFormationSendResponse Success");
    } catch (error) {
        console.error("CloudFormationSendResponse Error:");
        if (error.response) {
                console.error(error.response);
        } else if (error.request) {
                console.error(error.request);
        } else {
                console.error("Error", error.message);
        }
        console.error(error.config);
        throw new Error("Could not send CloudFormation response");
    }
};