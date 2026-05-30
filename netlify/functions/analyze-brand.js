exports.handler = async function(event, context) {
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      message: "Brand Rater function is working."
    })
  };
};
